// Serviço de busca sob demanda. GET /buscar?q=termo  |  GET /ficha?r=ref&n=nome (ficha olfativa)
// Procura o termo na fonte de preços, abre a página só dos modelos que ainda não estão no catálogo
// (no máximo MAX_NOVOS_BUSCA por busca) e devolve só { n, i, p, r, a } — sem loja, dólar ou margem.
// Proteções: 1 pedido por vez à fonte, pausa entre pedidos, cache por termo, limite por cliente e
// limite global por minuto; se a fonte responder 403/429, fica 30 min sem consultá-la.
import http from "node:http";
import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  caminho, lerJson, gravarJson, lerLojas, hoje, criarCliente, Bloqueio,
  lerModelos, lerOfertas, lerBusca, lerFicha, ofertaPerfume, modeloEhSplash, nomeSplash, chaveSolta, nomePadrao, ofertasDasLojas, normalizar, parametrosPreco, produtoPublico,
} from "../scraper/comum.mjs";
import { alertar } from "../scraper/alerta.mjs";

const env = process.env;
const PORTA = Number(env.PORTA || 8098);
const ORIGENS = (env.ORIGEM || "*").split(",").map((s) => s.trim()).filter(Boolean);
const DESCOBERTOS = env.DESCOBERTOS || caminho("descobertos.json");
const FICHAS = env.FICHAS || join(dirname(DESCOBERTOS), "fichas.json");
const MAX_NOVOS_BUSCA = Number(env.MAX_NOVOS_BUSCA || 3);
const CACHE_MS = Number(env.CACHE_HORAS || 12) * 3600e3;
const POR_CLIENTE_MIN = Number(env.BUSCAS_POR_MINUTO || 8);
const PEDIDOS_FONTE_MIN = Number(env.PEDIDOS_FONTE_POR_MINUTO || 20);
const PAUSA_BLOQUEIO_MS = 30 * 60e3;
// links de revenda: cada lojista tem um código, com nome da loja, WhatsApp e margem (%) sobre o preço do catálogo.
// O catálogo do lojista sai daqui já com a margem: o cliente dele nunca recebe o preço de custo.
const REVENDEDORES = env.REVENDEDORES || join(dirname(DESCOBERTOS), "revendedores.json");
const DATA_JSON = env.DATA_JSON || join(dirname(fileURLToPath(import.meta.url)), "..", "site", "data.json");
const CRIACOES_POR_HORA = Number(env.LINKS_POR_HORA || 5);
const comMargem = (p, m) => Math.ceil(p * (1 + m / 100) - 1e-9);
const lerCorpo = (req) => new Promise((ok, falha) => {
  let s = "";
  req.on("data", (b) => { s += b; if (s.length > 4000) { falha(new Error("grande demais")); req.destroy(); } });
  req.on("end", () => ok(s));
  req.on("error", falha);
});

export function criarServico({ cliente = criarCliente({ esperaMs: Number(env.ESPERA_API_MS ?? 1000) }) } = {}) {
  const preco = parametrosPreco();
  const nomes = lerLojas().map((l) => l.nome);
  const cache = new Map(); // termo -> { em, corpo }
  const porCliente = new Map(); // ip -> [instantes]
  let pedidosFonte = []; // instantes dos pedidos à fonte (janela de 1 min)
  let bloqueadoAte = 0;
  const naoPerfume = new Set(); // modelos já abertos que não servem (loção de verdade, sem nossas lojas)

  // catálogo conhecido = bruto.json (recarregado quando muda) + descobertos.json
  let bruto = { produtos: [] }, mtime = 0;
  const catalogo = () => {
    const arq = caminho("bruto.json");
    if (existsSync(arq) && statSync(arq).mtimeMs !== mtime) { bruto = lerJson(arq); mtime = statSync(arq).mtimeMs; }
    const extra = lerJson(DESCOBERTOS, []);
    const porId = new Map(), porNome = new Map(), porOferta = new Map(), porChaveSolta = new Map();
    for (const p of [...bruto.produtos, ...extra]) {
      if (p.id) porId.set(String(p.id), p);
      porNome.set(normalizar(p.n), p);
      for (const o of p.o || []) porOferta.set(`${o[0]}:${o[2]}`, p);
      if (String(p.id || "").startsWith("o")) { const k = chaveSolta(p.nomeOriginal || p.n); if (k) porChaveSolta.set(k, p); }
    }
    return { porId, porNome, porOferta, porChaveSolta, extra, cotacao: preco.cotacaoFixa || bruto.cotacao };
  };

  const podeConsultarFonte = (n) => {
    const agora = Date.now();
    pedidosFonte = pedidosFonte.filter((t) => agora - t < 60e3);
    return agora >= bloqueadoAte && pedidosFonte.length + n <= PEDIDOS_FONTE_MIN;
  };
  const pedir = async (path) => { pedidosFonte.push(Date.now()); return (await cliente.get(path)).html; };

  async function buscar(termo) {
    const chave = normalizar(termo);
    const c = cache.get(chave);
    if (c && Date.now() - c.em < CACHE_MS) return c.corpo;
    if (!podeConsultarFonte(1)) return { produtos: [], indisponivel: true };

    const cat = catalogo();
    const saida = [], novos = [];
    let parcial = false;
    try {
      const html = await pedir(`/busca/?q=${encodeURIComponent(termo)}`);
      const { itens } = lerModelos(html);
      // ofertas soltas (sem modelo, ex.: kits) das nossas lojas: entram como produto próprio, 1 oferta
      const vistos = new Set();
      for (const it of lerBusca(html).itens) {
        const k = nomes.indexOf(it.loja);
        const chaveOferta = `${k}:${it.cod}`;
        if (k < 0 || !it.idOferta || !ofertaPerfume(it.nome) || vistos.has(chaveOferta)) continue;
        vistos.add(chaveOferta);
        // já no catálogo pela oferta, pelo id, ou o mesmo item sem modelo vindo de outra loja (mesma chave)
        const chaveS = chaveSolta(it.nome);
        const conhecido = cat.porOferta.get(chaveOferta) || cat.porId.get("o" + it.idOferta) || (chaveS && cat.porChaveSolta.get(chaveS));
        if (conhecido) { if (!saida.includes(conhecido)) saida.push(conhecido); continue; }
        const prod = { id: "o" + it.idOferta, n: nomePadrao(it.nome), nomeOriginal: it.nome, i: it.img, o: [[k, it.usd, it.cod, hoje()]] };
        novos.push(prod);
        saida.push(prod);
        if (chaveS) cat.porChaveSolta.set(chaveS, prod);
        cat.porOferta.set(chaveOferta, prod);
      }
      let abertos = 0;
      for (const m of itens) {
        if (naoPerfume.has(m.id)) continue;
        const conhecido = cat.porId.get(m.id) || cat.porNome.get(normalizar(m.nome)) || cat.porNome.get(normalizar(nomeSplash(m.nome)));
        if (conhecido) { if (!saida.includes(conhecido)) saida.push(conhecido); continue; }
        if (abertos >= MAX_NOVOS_BUSCA || !podeConsultarFonte(1)) { parcial = true; continue; }
        abertos++;
        const pagina = await pedir(m.href);
        // "Loção Corporal" anunciado pelas lojas como splash/mist/colônia vira "Body Splash ..."; senão fica como loção
        const nomeModelo = m.verificarSplash && modeloEhSplash(lerBusca(pagina).itens.map((x) => x.nome)) ? nomeSplash(m.nome) : m.nome;
        const o = ofertasDasLojas(lerOfertas(pagina), nomes, hoje());
        if (!o.length) { naoPerfume.add(m.id); continue; }
        const ja = o.map((x) => cat.porOferta.get(`${x[0]}:${x[2]}`)).find(Boolean);
        if (ja) { if (!saida.includes(ja)) saida.push(ja); continue; }
        const prod = { id: m.id, n: nomeModelo, i: m.img, o };
        novos.push(prod);
        saida.push(prod);
      }
    } catch (e) {
      if (e instanceof Bloqueio) {
        bloqueadoAte = Date.now() + PAUSA_BLOQUEIO_MS;
        console.warn(`fonte respondeu ${e.message}; pausa de 30 min`);
        alertar(`A busca sob demanda foi bloqueada pela fonte (${e.message}). Ela fica 30 min parada; o site segue com o catálogo.`);
        return { produtos: [], indisponivel: true };
      }
      console.warn("erro na busca:", e.message);
      parcial = true;
    }
    if (novos.length) {
      const extra = lerJson(DESCOBERTOS, []);
      const ja = new Set(extra.map((p) => String(p.id)));
      gravarJson(DESCOBERTOS, [...extra, ...novos.filter((p) => !ja.has(String(p.id)))]);
    }
    const corpo = { produtos: saida.map((p) => produtoPublico(p, cat.cotacao, preco)).filter(Boolean), parcial };
    if (!parcial) cache.set(chave, { em: Date.now(), corpo });
    return corpo;
  }

  // ficha olfativa: achada pela referência (r) ou pelo nome; guardada em FICHAS por 90 dias
  const fichaDoCache = (k) => {
    const c = lerJson(FICHAS, {})[k];
    return c && Date.now() - c.em < (c.f ? 90 : 30) * 864e5 ? c : null;
  };
  function produtoDaFicha(ref, nome) {
    const cat = catalogo();
    for (const parte of String(ref || "").split(",")) {
      const [l, c] = parte.split("-");
      const p = cat.porOferta.get(`${l}:${c}`);
      if (p) return p;
    }
    return nome ? cat.porNome.get(normalizar(nome)) : null;
  }
  const chaveFicha = (p) => (p.id ? "m" + p.id : "n:" + normalizar(p.n));
  async function ficha(p) {
    if (String(p.id || "").startsWith("o")) return { ficha: null }; // kit em oferta solta: sem ficha
    const k = chaveFicha(p);
    const c = fichaDoCache(k);
    if (c) return { ficha: c.f };
    if (!podeConsultarFonte(2)) return { ficha: null, indisponivel: true };
    try {
      let id = p.id;
      if (!id) {
        const { itens } = lerModelos(await pedir(`/busca/?q=${encodeURIComponent(p.n)}`));
        id = itens.find((m) => normalizar(m.nome) === normalizar(p.n))?.id;
      }
      const f = id ? lerFicha(await pedir(`/perfume_${id}/`)) : null;
      gravarJson(FICHAS, { ...lerJson(FICHAS, {}), [k]: { em: Date.now(), f } });
      return { ficha: f };
    } catch (e) {
      if (e instanceof Bloqueio) {
        bloqueadoAte = Date.now() + PAUSA_BLOQUEIO_MS;
        console.warn(`fonte respondeu ${e.message}; pausa de 30 min`);
        alertar(`A busca sob demanda foi bloqueada pela fonte (${e.message}). Ela fica 30 min parada; o site segue com o catálogo.`);
        return { ficha: null, indisponivel: true };
      }
      console.warn("erro na ficha:", e.message);
      return { ficha: null };
    }
  }

  // ---------- preço na hora (itens do orçamento) ----------
  // Consulta ao vivo a página do modelo de cada item e devolve o preço final do momento (guarda 30 min).
  // Itens sem modelo (kits etc.) ficam com o preço da última coleta.
  const CONFERIR_MS = Number(env.CONFERIR_MINUTOS || 30) * 60e3;
  const conferidos = new Map(); // chave do produto -> { em, prod }
  async function conferir(refs) {
    const cat = catalogo();
    const itens = [];
    for (const ref of refs.slice(0, 15)) {
      const p = produtoDaFicha(ref, null);
      if (!p) continue;
      const k = chaveFicha(p);
      let c = conferidos.get(k);
      if (!c || Date.now() - c.em > CONFERIR_MS) {
        let atual = p;
        if (!String(p.id || "").startsWith("o") && podeConsultarFonte(2)) {
          try {
            let id = p.id;
            if (!id) id = lerModelos(await pedir(`/busca/?q=${encodeURIComponent(p.n)}`)).itens.find((m) => normalizar(m.nome) === normalizar(p.n))?.id;
            if (id) {
              const o = ofertasDasLojas(lerOfertas(await pedir(`/perfume_${id}/`)), nomes, hoje());
              if (o.length) atual = { ...p, o };
            }
          } catch (e) {
            if (e instanceof Bloqueio) { bloqueadoAte = Date.now() + PAUSA_BLOQUEIO_MS; console.warn(`fonte respondeu ${e.message}; pausa de 30 min`); }
            else console.warn("erro ao conferir:", e.message);
          }
        }
        c = { em: Date.now(), prod: atual };
        conferidos.set(k, c);
        if (conferidos.size > 3000) conferidos.clear();
      }
      const pub = produtoPublico(c.prod, cat.cotacao, preco);
      if (pub) itens.push({ ref, n: pub.n, p: pub.p, r: pub.r, a: pub.a });
    }
    return { itens };
  }

  // ---------- revenda ----------
  const lojaDe = (cod) => (cod && /^[a-z0-9-]{4,48}$/i.test(cod) ? lerJson(REVENDEDORES, {})[cod] || null : null);
  // código do link = nome da loja em formato de endereço + 4 caracteres aleatórios (ex.: loja-da-ana-k7m2)
  const slug = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "loja";
  let cacheCat = { mtime: -1, porChave: new Map() };
  function catalogoDaLoja(cod, loja) {
    const mt = existsSync(DATA_JSON) ? statSync(DATA_JSON).mtimeMs : 0;
    if (mt !== cacheCat.mtime) cacheCat = { mtime: mt, porChave: new Map() };
    const k = `${cod}:${loja.margem}:${loja.nome}:${loja.whatsapp}`;
    if (!cacheCat.porChave.has(k)) {
      const d = lerJson(DATA_JSON, { produtos: [] });
      cacheCat.porChave.set(k, JSON.stringify({
        loja: { nome: loja.nome, whatsapp: loja.whatsapp },
        atualizadoEm: d.atualizadoEm,
        produtos: d.produtos.map((p) => ({ ...p, p: comMargem(p.p, loja.margem) })),
      }));
    }
    return cacheCat.porChave.get(k);
  }
  const criacoes = new Map(); // ip -> instantes de criação de link (janela de 1 h)
  function criarLink(dados, ip) {
    const nome = String(dados.nome || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const whatsapp = String(dados.whatsapp || "").replace(/\D/g, "");
    const margem = Number(String(dados.margem ?? "").replace(",", "."));
    if (nome.length < 2) return [400, { erro: "Informe o nome da loja." }];
    if (!/^\d{10,15}$/.test(whatsapp)) return [400, { erro: "WhatsApp inválido: use DDI + DDD + número, só números (ex.: 5541999998888)." }];
    if (!Number.isFinite(margem) || margem < 0 || margem > 300) return [400, { erro: "A margem deve ficar entre 0% e 300%." }];
    const agora = Date.now();
    const lista = (criacoes.get(ip) || []).filter((t) => agora - t < 3600e3);
    if (lista.length >= CRIACOES_POR_HORA) return [429, { erro: "Muitos links criados. Tente de novo em uma hora." }];
    lista.push(agora); criacoes.set(ip, lista);
    const todos = lerJson(REVENDEDORES, {});
    let cod;
    do cod = `${slug(nome)}-${randomBytes(4).toString("hex").slice(0, 4)}`; while (todos[cod]);
    todos[cod] = { nome, whatsapp, margem: Math.round(margem * 100) / 100, criadoEm: new Date().toISOString() };
    gravarJson(REVENDEDORES, todos);
    return [200, { codigo: cod, nome, margem: todos[cod].margem }];
  }

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    // ORIGEM pode listar vários endereços separados por vírgula (ex.: site novo e antigo durante a migração)
    const origem = req.headers.origin || "";
    res.setHeader("access-control-allow-origin", ORIGENS.includes("*") ? "*" : ORIGENS.includes(origem) ? origem : ORIGENS[0]);
    res.setHeader("vary", "Origin");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    const responder = (status, obj) => { res.statusCode = status; res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, POST");
      res.setHeader("access-control-allow-headers", "content-type");
      res.statusCode = 204; return res.end();
    }
    if (u.pathname === "/saude") return responder(200, { ok: true });
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const liberado = () => {
      const agora = Date.now();
      const lista = (porCliente.get(ip) || []).filter((t) => agora - t < 60e3);
      if (lista.length >= POR_CLIENTE_MIN) return false;
      lista.push(agora);
      porCliente.set(ip, lista);
      if (porCliente.size > 5000) porCliente.clear();
      return true;
    };

    if (u.pathname === "/revenda" && req.method === "POST") {
      try { const [st, obj] = criarLink(JSON.parse(await lerCorpo(req) || "{}"), ip); return responder(st, obj); }
      catch { return responder(400, { erro: "Dados inválidos." }); }
    }
    if (u.pathname === "/conferir" && req.method === "GET") {
      const refs = u.searchParams.getAll("r").map((x) => String(x).slice(0, 300)).filter(Boolean);
      if (!refs.length) return responder(400, { erro: "sem itens" });
      const codLoja = u.searchParams.get("loja"), lojaC = codLoja ? lojaDe(codLoja) : null;
      if (codLoja && !lojaC) return responder(404, { erro: "Link de loja não encontrado." });
      if (!liberado()) return responder(429, { erro: "aguarde um minuto" });
      try {
        const r = await conferir(refs);
        if (lojaC) r.itens = r.itens.map((x) => ({ ...x, p: comMargem(x.p, lojaC.margem) }));
        return responder(200, r);
      } catch (e) { console.error(e); return responder(500, { erro: "falha ao conferir" }); }
    }
    if (u.pathname === "/catalogo" && req.method === "GET") {
      const cod = u.searchParams.get("loja"), loja = lojaDe(cod);
      if (!loja) return responder(404, { erro: "Link de loja não encontrado." });
      return responder(200, catalogoDaLoja(cod, loja));
    }
    if (!["/buscar", "/ficha"].includes(u.pathname) || req.method !== "GET") return responder(404, { erro: "não encontrado" });

    if (u.pathname === "/ficha") {
      const p = produtoDaFicha(u.searchParams.get("r"), u.searchParams.get("n"));
      if (!p) return responder(200, { ficha: null });
      if (!fichaDoCache(chaveFicha(p)) && !liberado()) return responder(429, { erro: "aguarde um minuto" });
      try { return responder(200, await ficha(p)); }
      catch (e) { console.error(e); return responder(500, { erro: "falha na ficha" }); }
    }

    const termo = (u.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (normalizar(termo).length < 3) return responder(400, { erro: "digite ao menos 3 letras" });
    if (!liberado()) return responder(429, { erro: "muitas buscas; aguarde um minuto" });
    // no link de um lojista, a busca devolve os preços já com a margem dele
    const codLoja = u.searchParams.get("loja");
    const lojaBusca = codLoja ? lojaDe(codLoja) : null;
    if (codLoja && !lojaBusca) return responder(404, { erro: "Link de loja não encontrado." });

    try {
      const corpo = await buscar(termo);
      responder(200, lojaBusca ? { ...corpo, produtos: corpo.produtos.map((p) => ({ ...p, p: comMargem(p.p, lojaBusca.margem) })) } : corpo);
    }
    catch (e) { console.error(e); responder(500, { erro: "falha na busca" }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  criarServico().listen(PORTA, () => console.log(`busca sob demanda na porta ${PORTA}`));
}
