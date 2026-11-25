// Funções compartilhadas pelo coletor, pela publicação e pelo serviço de busca.
// O endereço da fonte de preços vem da variável FONTE_URL (não fica no código).
import * as cheerio from "cheerio";
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AQUI = dirname(fileURLToPath(import.meta.url));
export const DADOS_DIR = process.env.DADOS_DIR || AQUI;
export const UA = "Mozilla/5.0 (compatible; CatalogoPerfumes/1.0)";
// nome da fonte, para tirar menções a ela dos textos copiados (vem de FONTE_NOME ou do endereço em FONTE_URL)
const NOME_FONTE = (process.env.FONTE_NOME || (process.env.FONTE_URL || "").replace(/^https?:\/\/(www\.|mobile\.)?/i, "").split(/[.:/]/)[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const RE_FONTE = NOME_FONTE.length >= 5 && !/^\d+$/.test(NOME_FONTE)
  ? new RegExp("[\\s,;–-]*(no |do |pelo |em )?" + NOME_FONTE.split("").join("\\s?") + "\\S*", "gi") : null;
export const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- datas (dia no fuso de Brasília, "AAAA-MM-DD") ----------
export const hoje = () =>
  process.env.HOJE || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
export const dias = (de, ate) => (de ? Math.round((Date.parse(ate) - Date.parse(de)) / 864e5) : Infinity);

// ---------- arquivos JSON ----------
export const caminho = (nome) => join(DADOS_DIR, nome);
export function lerJson(arq, padrao) {
  if (!existsSync(arq)) {
    if (padrao !== undefined) return padrao;
    throw new Error(`arquivo não encontrado: ${arq}`);
  }
  return JSON.parse(readFileSync(arq, "utf8"));
}
export function gravarJson(arq, obj) {
  mkdirSync(dirname(arq), { recursive: true });
  const tmp = arq + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, arq);
}
export const lerLojas = () => lerJson(caminho("lojas.json"));

// ---------- criptografia (AES-256-GCM, chave derivada de DADOS_CHAVE) ----------
const MAGICO = Buffer.from("CPE1");
function chave() {
  const h = process.env.DADOS_CHAVE || "";
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error("DADOS_CHAVE ausente ou inválida (precisa de 64 caracteres hex)");
  return Buffer.from(hkdfSync("sha256", Buffer.from(h, "hex"), Buffer.alloc(0), "catalogo-perfumes/dados/v1", 32));
}
export function cifrar(buf) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chave(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGICO, iv, c.getAuthTag(), ct]);
}
export function decifrar(buf) {
  if (!buf.subarray(0, 4).equals(MAGICO)) throw new Error("arquivo cifrado em formato desconhecido");
  const d = createDecipheriv("aes-256-gcm", chave(), buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

// ---------- cliente educado: 1 pedido por vez, pausa com sorteio, para no 403/429 ----------
export class Bloqueio extends Error {
  constructor(status, url) {
    super(`HTTP ${status} em ${url}`);
    this.status = status;
  }
}
export class LimitePedidos extends Error {}

export function criarCliente({
  base = process.env.FONTE_URL,
  esperaMs = Number(process.env.ESPERA_MS ?? 10000),
  sorteio = 0.5,
  maxPedidos = Number(process.env.MAX_PEDIDOS || Infinity),
} = {}) {
  if (!base) throw new Error("FONTE_URL não definida");
  base = base.replace(/\/$/, "");
  let pedidos = 0, bytes = 0, ultimo = 0, fila = Promise.resolve();
  const umPedido = async (path) => {
    if (pedidos >= maxPedidos) throw new LimitePedidos(`limite de ${maxPedidos} pedidos atingido`);
    const espera = ultimo + esperaMs * (1 + Math.random() * sorteio) - Date.now();
    if (ultimo && espera > 0) await dorme(espera);
    const url = base + (path.startsWith("/") ? path : "/" + path);
    let erro;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        pedidos++;
        const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9" } });
        const html = await r.text();
        bytes += Buffer.byteLength(html);
        ultimo = Date.now();
        if (r.status === 403 || r.status === 429) throw new Bloqueio(r.status, path);
        if (!r.ok) throw new Error(`HTTP ${r.status} em ${path}`);
        return { html, url: r.url };
      } catch (e) {
        ultimo = Date.now();
        if (e instanceof Bloqueio || tentativa === 2 || pedidos >= maxPedidos) throw e;
        erro = e;
        await dorme(esperaMs);
      }
    }
    throw erro;
  };
  return {
    // serializa: mesmo com várias chamadas simultâneas, só 1 pedido por vez
    get: (path) => (fila = fila.then(() => umPedido(path), () => umPedido(path))),
    stats: () => ({ pedidos, bytes }),
  };
}

// ---------- leitura das páginas ----------
export const paraNumero = (txt) => {
  const m = /(\d[\d.]*,?\d*)/.exec(String(txt || ""));
  return m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : NaN;
};
const lerTotal = ($) => {
  const m = /\(\s*([\d.]+)\s*Resultados/i.exec($("body").text());
  return m ? Number(m[1].replace(/\./g, "")) : null;
};
const lerAnunciante = (bloco) =>
  ((/advertiser(?:'|&#39;|&apos;|")\s*:\s*(?:'|&#39;|&apos;|")(.*?)(?:'|&#39;|&apos;|")\s*[,}]/.exec(bloco) || [])[1] || "").trim();
const lerCodigo = (txt) => (/C[óo]digo:\s*([^\s|]+)/i.exec(txt) || [])[1] || "";
const lerUsd = ($el) => {
  const t = $el.find(".promocao-item-preco-oferta").text();
  const m = /US\$\s*([\d.,]+)/.exec(t);
  return m ? paraNumero(m[1]) : NaN;
};
const imagem = ($, el) => {
  const im = $(el).find("img").first();
  let img = im.attr("data-src") || im.attr("src") || "";
  if (/loading-images|\.svg$/.test(img)) img = im.attr("data-src") || "";
  return img || null;
};
// modelo = link com "_<id>/" (um sublinhado); oferta isolada usa "__<id>/"
export const idModelo = (href) => (/[^_]_(\d+)\/?$/.exec(href || "") || [])[1] || null;
// tipos de modelo aceitos: perfumes e kits de perfume
export const ehPerfume = (href) => /^\/?(perfume|kit-perfumes?)-/i.test(href || "");
export const idOferta = (href) => (/__(\d+)\/?$/.exec(href || "") || [])[1] || null;
// body splash / body mist / colônia (e não loção, creme, hidratante...)
export function ehSplash(nome) {
  const n = String(nome || "");
  return /\b(body\s*splash|body\s*mist|splash|fragrance\s*mist|col[oô]nia)\b/i.test(n)
    && !/\b(lo[çc][ãa]o|lotion|creme|cream|hidratante|manteiga|butter|gel|sabonete|shampoo|esfoliante)\b/i.test(n);
}
// modelos "Loção Corporal" que, na verdade, são body splash: decide pelo nome que as lojas dão às ofertas
export function modeloEhSplash(nomesOfertas) {
  const n = nomesOfertas.filter(Boolean);
  return n.length > 0 && n.filter(ehSplash).length / n.length >= 0.5;
}
// "Loção Corporal VS Love Spell 250ML" anunciado como splash -> "Victoria's Secret Love Spell Body Splash 250ML" (mesmo padrão dos outros)
export const nomeSplash = (nome) => nomePadrao(String(nome).replace(/^Lo[çc][ãa]o Corporal\s+/i, "Body Splash "));
// creme / loção / hidratante corporal (e não creme dental, de barbear, capilar...)
export function ehCreme(nome) {
  const n = String(nome || "");
  return /\b(lo[çc][ãa]o|lotion|creme|cream|hidratante|body butter|manteiga corporal)\b/i.test(n)
    && !/\b(dental|dente|barbear|cabelo|capilar|shampoo|condicionador|pentear)\b/i.test(n);
}
// hair mist (perfume para cabelo)
export const ehHairMist = (nome) => /\b(hair\s*mist|hair\s*perfume|perfume\s+(para|de|capilar)\s*(o\s+)?cabelos?|perfume capilar|bruma capilar)\b/i.test(String(nome || ""));
// tipos de modelo de cuidado corporal aceitos (além de perfume)
export const ehModeloCorpo = (href) => /^\/?(locao-corporal|creme-corporal|creme-hidratante|hidratante-corporal|body-splash|body-mist|hair-mist|bruma-capilar)-/i.test(href || "");
// itens que nunca entram (mesmo citando perfume)
const FORA = /\b(sabonete|desodorante|aromatizador|aromatizante|air freshener|difusor|vela|shampoo|condicionador|gel de banho|creme dental)\b/i;
// nome de oferta solta que é perfume, kit, body splash ou creme/loção corporal
export function ofertaPerfume(nome) {
  const n = String(nome || "");
  if (/\bkit\b/i.test(n)) return /\b(perfumes?|edp|edt|eau|parfum|\d+\s*ml)\b/i.test(n);
  if (FORA.test(n)) return false;
  if (ehSplash(n) || ehCreme(n) || ehHairMist(n)) return true;
  if (/\bbody\b/i.test(n)) return false;
  return /\b(perfume|edp|edt|eau de (parfum|toilette)|extrait|parfum)\b/i.test(n);
}

// ---------- itens sem modelo: chave para achar o mesmo produto em lojas diferentes ----------
// Tira gênero, pontuação e palavras genéricas e ignora a ordem; mantém marca, nome, tipo (kit, refil, body mist...),
// a concentração (EDP e EDT continuam diferentes) e o tamanho em ml. Só nomes com a mesma chave são juntados.
const CONC = [[/\b(eau de parfum|edp)\b/g, " edp "], [/\b(eau de toilette|edt)\b/g, " edt "], [/\b(eau de cologne|edc)\b/g, " edc "], [/\bextrait( de parfum)?\b/g, " extrait "]];
export function chaveSolta(nome) {
  let n = String(nome || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // todos os tamanhos (kits têm vários): "100ml+12ml" e "100ml+30ml" continuam diferentes
  const ml = [...n.matchAll(/(\d+(?:[.,]\d+)?)\s*ml\b/g)].map((x) => x[1].replace(",", ".")).sort().join("+");
  n = n.replace(/(\d+(?:[.,]\d+)?)\s*ml\b/g, " ");
  for (const [re, t] of CONC) n = n.replace(re, t);
  n = n.replace(/\b(perfumes?|masculino|feminino|unissex|unisex|masc|fem|para|de|da|do|c\/s|s\/c)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ");
  const palavras = [...new Set(n.split(/\s+/).filter(Boolean))].sort();
  return palavras.length ? `${palavras.join(" ")}|${ml}` : "";
}

// ---------- itens sem modelo: nome no padrão dos modelos (Marca Nome [Tipo] Concentração Gênero Tamanho) ----------
const TITULO = (s) => s.toLowerCase().replace(/(^|[\s\-/(])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase());
export function nomePadrao(nome) {
  let n = String(nome || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  // kits e conjuntos com vários tamanhos ("100ML+12ML", "4 X 25ML"): mantém o nome da loja, só arruma maiúsculas
  if ((n.match(/\d+(?:[.,]\d+)?\s*ml\b/gi) || []).length > 1 || /\+|\b\d+\s*x\s*\d/i.test(n)) {
    n = n.replace(/^\s*perfume\s+/i, "");
    return n === n.toUpperCase() && /[A-Z]{3}/.test(n) ? TITULO(n).replace(/(\d+)\s*ml\b/gi, "$1ML") : n;
  }
  const genero = /\bmasc(ulino)?\b/i.test(n) ? "Masculino" : /\bfem(inino)?\b/i.test(n) ? "Feminino" : /\buniss?ex\b/i.test(n) ? "Unissex" : "";
  const conc = /\b(eau de parfum|edp)\b/i.test(n) ? "Eau de Parfum" : /\b(eau de toilette|edt)\b/i.test(n) ? "Eau de Toilette"
    : /\bextrait( de parfum)?\b/i.test(n) ? "Extrait de Parfum" : /\b(eau de cologne|edc)\b/i.test(n) ? "Eau de Cologne" : "";
  const m = n.match(/(\d+(?:[.,]\d+)?)\s*ml\b/i);
  const tamanho = m ? `${m[1].replace(",", ".")}ML` : "";
  n = n.replace(/(\d+(?:[.,]\d+)?)\s*ml\b/gi, " ")
    .replace(/\b(eau de parfum|edp|eau de toilette|edt|extrait( de parfum)?|eau de cologne|edc)\b/gi, " ")
    .replace(/\b(masculino|feminino|unissex|unisex|masc|fem)\b\.?/gi, " ")
    .replace(/^\s*perfume\s+/i, "").replace(/(^|\s)-(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
  if (n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = TITULO(n); // nome todo em maiúsculas (algumas lojas escrevem assim)
  // tipo no começo (Body Mist, Body Splash, Hair Mist) vai para depois do nome, como nos modelos
  const tipo = n.match(/^(body mist|body splash|hair mist|splash)\s+/i);
  if (tipo) n = `${n.slice(tipo[0].length)} ${TITULO(tipo[1])}`;
  return [n, conc, genero, tamanho].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// junta os itens sem modelo (id "o...") que são o mesmo produto em lojas diferentes e padroniza o nome deles.
// Fica o item da loja de maior prioridade (nome e foto dele; foto da outra se faltar). Devolve quantos foram juntados.
export function arrumarSoltos(produtos) {
  const porChave = new Map();
  let juntados = 0;
  const melhorLoja = (p) => Math.min(...p.o.map((x) => x[0]));
  // body splash com modelo gravados no formato antigo ("Body Splash Marca Nome 250ML") passam para o padrão novo
  for (const p of produtos) if (/^Body Splash\s/i.test(p.n) && !String(p.id || "").startsWith("o")) p.n = nomePadrao(p.n);
  const soltos = produtos.filter((p) => String(p.id || "").startsWith("o")).sort((a, b) => melhorLoja(a) - melhorLoja(b));
  const remover = new Set();
  for (const p of soltos) {
    if (!p.nomeOriginal) { p.nomeOriginal = p.n; p.n = nomePadrao(p.n); }
    const k = chaveSolta(p.nomeOriginal);
    if (!k) continue;
    const dono = porChave.get(k);
    if (!dono) { porChave.set(k, p); continue; }
    for (const o of p.o) {
      const ja = dono.o.find((x) => x[0] === o[0]);
      if (!ja) dono.o.push(o);
      else if (o[1] < ja[1]) Object.assign(ja, o);
    }
    if (!dono.i && p.i) dono.i = p.i;
    remover.add(p);
    juntados++;
  }
  if (remover.size) for (let i = produtos.length - 1; i >= 0; i--) if (remover.has(produtos[i])) produtos.splice(i, 1);
  return juntados;
}

// termo de busca a partir do nome que a loja dá à oferta: tira palavras genéricas, gênero, concentração e tamanho
export function termoBusca(nome) {
  return String(nome || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(perfumes?|masculino|feminino|unissex|unisex|masc|fem|edp|edt|edc|eau|de|parfum|toilette|cologne|extrait|para|com|spray|vapo|natural|original|tester|c\/s|s\/c)\b\.?/gi, " ")
    .replace(/\d+([.,]\d+)?\s*(ml|oz|g|gr)\b/gi, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
}

// busca filtrada por loja: ofertas [{loja, cod, usd, nome}]
export function lerBusca(html) {
  const $ = cheerio.load(html);
  const itens = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const loja = lerAnunciante($.html(el));
    const cod = lerCodigo($(el).text());
    const usd = lerUsd($(el));
    if (!loja || !cod || !usd) return;
    const a = $(el).find(".promocao-item-nome a").first();
    itens.push({ loja, cod, usd, nome: a.text().trim(), idOferta: idOferta(a.attr("href")), img: imagem($, el) });
  });
  return { itens, total: lerTotal($) };
}

// listagem/busca geral de modelos: [{id, href, nome, img, verificarSplash}]
// "Loção Corporal" entra marcado para verificar: só fica se as lojas o anunciam como body splash
export function lerModelos(html) {
  const $ = cheerio.load(html);
  const itens = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const a = $(el).find(".promocao-item-nome a").first();
    const href = a.attr("href");
    const id = idModelo(href);
    if (!id) return;
    const verificarSplash = /^\/?locao-corporal-/i.test(href);
    if (!(ehPerfume(href) || ehModeloCorpo(href) || (/^\/?kit-/i.test(href) && ofertaPerfume(a.text())))) return;
    itens.push({ id, href, nome: a.text().trim().replace(/^Perfume\s+/i, ""), img: imagem($, el), verificarSplash });
  });
  return { itens, total: lerTotal($) };
}

// página do modelo: ofertas de todas as lojas [{loja, usd, cod}]
export function lerOfertas(html) {
  const $ = cheerio.load(html);
  const ofertas = [];
  $(".promocao-produtos-item-text").each((_, el) => {
    const loja = lerAnunciante($.html(el));
    const precoTxt = $(el).find(".promocao-item-preco-oferta strong, .promocao-item-preco-oferta span").first().text();
    const usd = paraNumero(precoTxt);
    if (!loja || !usd) return;
    ofertas.push({ loja, usd, cod: lerCodigo($(el).text()) });
  });
  return ofertas;
}

// ficha olfativa da página do modelo (descrição, notas, duração...). null se a página não tiver ficha.
export function lerFicha(html) {
  const $ = cheerio.load(html);
  const txt = (el) => $(el).text().replace(/\s+/g, " ").trim();
  const lead = txt($(".ficha-olfativa-lead").first());
  if (!lead && !$(".ficha-olfativa-piramide").length) return null;
  const badge = (rotulo) => {
    let v = "";
    $(".ficha-olfativa-badges li").each((_, li) => {
      const r = txt($(li).find(".ficha-olfativa-badge-rotulo"));
      if (r.toLowerCase() === rotulo.toLowerCase()) v = txt(li).slice(r.length).trim();
    });
    return v;
  };
  const notas = (cls) => $(`.ficha-olfativa-piramide-${cls}`).first().find(".ficha-olfativa-notas li").map((_, li) => txt(li)).get();
  // "Quando usar": itens com barra; entram os de barra >= 50%
  const usar = [];
  $("section.ficha-olfativa-card").each((_, sec) => {
    if (!/quando usar/i.test(txt($(sec).find("h3")))) return;
    $(sec).find("li").each((_, li) => {
      const w = Number((/width:\s*(\d+(?:\.\d+)?)%/.exec($.html(li)) || [])[1]);
      const nome = txt(li);
      if (nome && (!Number.isFinite(w) || w >= 50)) usar.push(nome);
    });
  });
  // tira do texto qualquer menção ao nome da fonte (descoberto pelo endereço configurado, sem o nome escrito aqui)
  const limpa = (s) => (RE_FONTE ? s.replace(RE_FONTE, "") : s).trim();
  return {
    descricao: limpa(lead),
    publico: badge("Público"), lancamento: badge("Lançamento"), concentracao: badge("Concentração"),
    acordes: $(".ficha-olfativa-acorde-nome").map((_, e) => txt(e)).get().slice(0, 6),
    topo: notas("top"), coracao: notas("heart"), fundo: notas("base"),
    duracao: badge("Duração"), rastro: badge("Rastro"),
    usar: [...new Set(usar)].slice(0, 8),
  };
}

export function lerCotacao(html) {
  const txt = cheerio.load(html)("body").text().replace(/\s+/g, " ");
  const m = /Cota[çc][ãa]o do D[óo]lar\s*R\$\s*([\d.,]+)/i.exec(txt);
  return m ? paraNumero(m[1]) : null;
}

// ofertas das nossas lojas, a mais barata de cada loja: [[lojaIdx, usd, cod, t]]
export function ofertasDasLojas(ofertas, nomes, t) {
  const melhor = {};
  for (const o of ofertas) {
    const k = nomes.indexOf(o.loja);
    if (k < 0 || !o.cod) continue;
    if (!melhor[k] || o.usd < melhor[k][1]) melhor[k] = [k, o.usd, o.cod, t];
  }
  return Object.values(melhor).sort((a, b) => a[0] - b[0]);
}

export const normalizar = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^perfume\s+/, "").replace(/\s+/g, " ").trim();

// ---------- preço público ----------
export function parametrosPreco() {
  const margem = Number(process.env.MARGEM);
  if (!Number.isFinite(margem)) throw new Error("MARGEM não definida");
  return {
    margem,
    acrescimo: Number(process.env.ACRESCIMO_COTACAO || 0),
    cotacaoFixa: Number(process.env.COTACAO_FIXA) || null,
  };
}
// produto bruto -> { n, i, p, r, a } (sem loja, sem dólar, sem margem)
export function produtoPublico(prod, cotacao, { margem, acrescimo }) {
  const o = (prod.o || []).filter((x) => x && x[1] > 0).sort((a, b) => a[0] - b[0]);
  if (!o.length || !cotacao) return null;
  const ref = o[0];
  const p = Math.ceil(ref[1] * cotacao * (1 + acrescimo) * (1 + margem) - 1e-9);
  return { n: prod.n, i: prod.i || null, p, r: o.map((x) => `${x[0]}-${x[2]}`).join(","), a: ref[3] };
}
