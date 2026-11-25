// Testes do coletor, da publicação, da criptografia e do serviço de busca contra um servidor falso
// que imita o HTML da fonte de preços. Não acessa a internet.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const AQUI = dirname(fileURLToPath(import.meta.url));
const LOJAS = [
  { slug: "loja-alfa", nome: "Loja Alfa", frequenciaDias: 1 },
  { slug: "loja-beta", nome: "Loja Beta", frequenciaDias: 7 },
];
const HOJE = "2026-11-20";
const CHAVE = randomBytes(32).toString("hex");

// ---------- servidor falso ----------
const oferta = (loja, usd, cod, nome = "Item") => `
<div class="promocao-produtos-item-text"><div class="promocao-item-nome"><a href="/x__1/">${nome}</a></div>
<div class="promocao-item-caracteristicas"> Código: ${cod} </div>
<a onclick="gtag( 'event', 'add_to_wishlist', { 'product': 'X', 'advertiser': '${loja}' } )">w</a>
<div class="promocao-item-preco-oferta flex column"><span><strong>US$ ${usd}</strong></span><div>R$ 1,00</div></div></div>`;
const modelo = (href, nome) => `
<div class="promocao-produtos-item-text"><img src="/static/images/loading-images.svg" data-src="https://img.exemplo${href}.png">
<div class="promocao-item-nome"><a href="${href}">Perfume ${nome}</a></div></div>`;
const pagina = (total, corpo) => `<body><h1>(${total} Resultados)</h1>${corpo}</body>`;

let modo = "normal", modoAlta = false;
const pedidos = [], alertas = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/message/sendText/teste") {
    let corpo = "";
    req.on("data", (b) => (corpo += b));
    return req.on("end", () => { alertas.push({ chave: req.headers.apikey, ...JSON.parse(corpo) }); res.end("{}"); });
  }
  pedidos.push(u.pathname + u.search);
  res.setHeader("content-type", "text/html; charset=utf-8");
  const fim = (html) => res.end(html);
  if (u.pathname === "/") return fim("<body><div>Cotação do Dólar</div><span>R$ 5,65</span></body>");
  if (u.pathname === "/busca/") {
    if (modo === "429") { res.statusCode = 429; return fim("devagar"); }
    const q = u.searchParams.get("q"), loja = u.searchParams.get("loja"), pag = Number(u.searchParams.get("page") || 1);
    if (modo === "429-dois" && /novo dois/i.test(q || "")) { res.statusCode = 429; return fim("devagar"); }
    if (!loja && q === "asad") {
      // ofertas soltas (sem modelo): kit e creme da nossa loja entram; aromatizador e loja de fora não
      const solta = (href, loja, usd, cod, nome) => oferta(loja, usd, cod, nome).replace('href="/x__1/"', `href="${href}"`);
      return fim(pagina(7, modelo("/creme-corporal-asad_9006/", "Creme Corporal Asad 280g") + modelo("/perfume-marca-x_5001/", "Marca X Masculino 100ML") + modelo("/kit-perfume-asad-duo_9005/", "Kit Asad Duo Masculino")
        + solta("/kit-asad-trio-100ml__7001/", "Loja Alfa", "40,00", "777", "Kit Perfume Asad Trio Edp 100ML")
        + solta("/creme-asad__7002/", "Loja Alfa", "9,00", "778", "Creme Hidratante Asad 200g")
        + solta("/asad-air-freshener__7004/", "Loja Alfa", "4,00", "782", "Lattafa Asad Air Freshener 300ML")
        + solta("/asad-hair-mist__7005/", "Loja Alfa", "8,00", "783", "Lattafa Asad Hair Mist 50ML")
        + solta("/kit-asad-outra__7003/", "Outra Loja", "30,00", "779", "Kit Perfume Asad Outra Edp")));
    }
    if (!loja && /novo um|fantasma/i.test(q)) return fim(pagina(1, modelo("/perfume-novo-um_9001/", "Novo Um Feminino 100ML")));
    if (!loja && /novo dois/i.test(q)) return fim(pagina(1, modelo("/perfume-novo-dois_9002/", "Novo Dois 100ML")));
    if (!loja && q === "love spell") {
      const solta = (href, loja, usd, cod, nome) => oferta(loja, usd, cod, nome).replace('href="/x__1/"', `href="${href}"`);
      return fim(pagina(3, modelo("/locao-corporal-vs-love-spell-250ml_9100/", "Loção Corporal Victoria's Secret Love Spell 250ML")
        + modelo("/locao-corporal-vs-amber-romance-236ml_9101/", "Loção Corporal Victoria's Secret Amber Romance 236ML")
        + solta("/body-splash-vs-bare-vanilla__7101/", "Loja Beta", "13,00", "881", "Body Splash Victoria's Secret Bare Vanilla 250ML")));
    }
    if (loja === "loja-alfa" && q === "perfume masculino" && pag === 1) {
      return fim(pagina(2, oferta("Loja Alfa", "18,50", "111") + oferta("Loja Alfa", "10,00", "999", "Perfume Desconhecido")));
    }
    return fim(pagina(0, ""));
  }
  if (u.pathname === "/perfume/") {
    const loja = u.searchParams.get("loja");
    if (!loja && modoAlta && Number(u.searchParams.get("page") || 1) === 1) {
      return fim(pagina(2, modelo("/perfume-alta-tres_9003/", "Alta Tres Feminino 100ML") + modelo("/perfume-marca-x_5001/", "Marca X Masculino 100ML")));
    }
    if (loja === "loja-alfa") return fim(pagina(4, modelo("/creme-corporal-y_9004/", "Creme") + modelo("/perfume-marca-x_5001/", "Marca X Masculino 100ML") + modelo("/perfume-novo-um_9001/", "Novo Um Feminino 100ML") + modelo("/perfume-novo-dois_9002/", "Novo Dois 100ML")));
    if (loja === "loja-beta") return fim(pagina(1, modelo("/perfume-novo-dois_9002/", "Novo Dois 100ML")));
    return fim(pagina(0, ""));
  }
  if (u.pathname === "/perfume-novo-dois_9002/") return fim(`<body>${oferta("Loja Beta", "31,00", "4440")}</body>`);
  if (u.pathname === "/perfume-novo-um_9001/") return fim(`<body>${oferta("Loja Alfa", "25,00", "333")}${oferta("Outra Loja", "5,00", "1")}${oferta("Loja Beta", "27,00", "444")}</body>`);
  if (u.pathname === "/kit-perfume-asad-duo_9005/") return fim(`<body>${oferta("Loja Beta", "30,00", "555")}</body>`);
  if (u.pathname === "/perfume-alta-tres_9003/") return fim(`<body>${oferta("Loja Beta", "26,00", "991")}</body>`);
  if (u.pathname === "/creme-corporal-asad_9006/") return fim(`<body>${oferta("Loja Alfa", "11,00", "780", "Creme Corporal Hidratante Lattafa Asad 280g")}</body>`);
  if (u.pathname === "/locao-corporal-vs-love-spell-250ml_9100/") return fim(`<body>${oferta("Loja Alfa", "10,75", "901", "Body Mist Feminino Victoria's Secret Love Spell 250ML")}${oferta("Outra Loja", "12,00", "902", "Victoria's Secret Splash Love Spell")}</body>`);
  if (u.pathname === "/locao-corporal-vs-amber-romance-236ml_9101/") return fim(`<body>${oferta("Loja Alfa", "15,00", "903", "Loção Hidratante Victoria's Secret Amber Romance 236ML")}${oferta("Outra Loja", "14,00", "904", "Loção Corporal VS Amber Romance")}</body>`);
  if (u.pathname === "/perfume_5001/") return fim(`<body><div class="ficha-olfativa-lead">O Marca X é um perfume âmbar, no Fonte Exemplo.</div>
<ul class="ficha-olfativa-badges"><li><span class="ficha-olfativa-badge-rotulo">Público</span> Masculino</li><li><span class="ficha-olfativa-badge-rotulo">Lançamento</span> 2021</li></ul>
<ul class="ficha-olfativa-acordes"><li><span class="ficha-olfativa-acorde"><span class="ficha-olfativa-acorde-nome">Âmbar</span></span></li></ul>
<ul class="ficha-olfativa-piramide"><li class="ficha-olfativa-piramide-top"><ul class="ficha-olfativa-notas"><li>Pimenta</li><li>Abacaxi</li></ul></li>
<li class="ficha-olfativa-piramide-heart"><ul class="ficha-olfativa-notas"><li>Café</li></ul></li><li class="ficha-olfativa-piramide-base"><ul class="ficha-olfativa-notas"><li>Baunilha</li></ul></li></ul>
<section class="ficha-olfativa-card"><h3>Quando usar</h3><ul><li><span style="width: 90%"></span>Inverno</li><li><span style="width: 20%"></span>Verão</li></ul></section>
<div class="ficha-olfativa-rodape"><ul class="ficha-olfativa-badges"><li><span class="ficha-olfativa-badge-rotulo">Duração</span> Longa Duração</li><li><span class="ficha-olfativa-badge-rotulo">Rastro</span> Forte</li></ul></div></body>`);
  res.statusCode = 404;
  fim("não");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const FONTE = `http://127.0.0.1:${server.address().port}`;

// ---------- utilitários ----------
const dir = mkdtempSync(join(tmpdir(), "catalogo-teste-"));
const arq = (n) => join(dir, n);
const ler = (n) => JSON.parse(readFileSync(arq(n), "utf8"));
const grava = (n, o) => writeFileSync(arq(n), JSON.stringify(o));
const ENV = { DADOS_DIR: dir, FONTE_URL: FONTE, FONTE_NOME: "fonteexemplo", ESPERA_MS: "1", HOJE, DADOS_CHAVE: CHAVE, MARGEM: "0.35", ACRESCIMO_COTACAO: "0.05", DESCOBERTOS: arq("descobertos.json"),
  EVOLUTION_URL: FONTE, EVOLUTION_INSTANCIA: "teste", EVOLUTION_APIKEY: "chave-teste", ALERTA_NUMERO: "5541000000000", AMPLIACAO_PEDIDOS: "0", AMPLIACAO_ATE: "" };
const rodar = (script, args = [], extra = {}) => new Promise((resolve) => {
  const f = spawn(process.execPath, [join(AQUI, script), ...args], { env: { ...process.env, ...ENV, ...extra } });
  let out = "";
  f.stdout.on("data", (b) => (out += b));
  f.stderr.on("data", (b) => (out += b));
  f.on("close", (status) => resolve({ status, out }));
});
const produtoX = () => ({ id: "5001", n: "Marca X Masculino 100ML", i: null, o: [[0, 20, "111", "2026-11-01"], [1, 30, "222", "2026-11-10"]] });
let ok = 0;
const passo = (nome) => console.log(`✔ ${nome}`) || ok++;

try {
  grava("lojas.json", LOJAS);

  // 1. casamento por lojaIdx:cod + agenda por loja + fila de novos
  grava("bruto.json", { versao: 1, cotacao: 5, produtos: [produtoX()] });
  grava("estado.json", { varredura: { "loja-alfa": "2026-11-15", "loja-beta": "2026-11-18" }, novos: "2026-11-19" });
  pedidos.length = 0;
  let r = await rodar("scrape.mjs");
  assert.equal(r.status, 0, r.out);
  let b = ler("bruto.json"), e = ler("estado.json");
  assert.deepEqual(b.produtos[0].o, [[0, 18.5, "111", HOJE], [1, 30, "222", "2026-11-10"]], "oferta conhecida atualiza usd e t");
  assert.equal(b.produtos.length, 1, "oferta desconhecida não entra no catálogo");
  assert.ok(e.fila.some((f) => f.k === "0:999"), "oferta desconhecida vai para a fila");
  assert.equal(b.cotacao, 5.65);
  passo("casamento por lojaIdx:cod (preço e data atualizados; desconhecida vai para a fila)");
  assert.ok(!pedidos.some((p) => p.includes("loja=loja-beta")), "loja semanal não vencida não é varrida");
  assert.equal(e.varredura["loja-alfa"], HOJE);
  assert.equal(e.varredura["loja-beta"], "2026-11-18");
  assert.ok(!pedidos.some((p) => p.startsWith("/perfume/") && p.includes("loja=")), "sem busca de novos fora da semana");
  assert.match(r.out, /Pedidos: \d+ \| [\d.]+ MB/);
  assert.match(r.out, /cobertura do catálogo 1\/1 \(100\.0%\)/);
  passo("agenda por loja (só a loja vencida; imprime pedidos, MB, tempo e cobertura)");

  // 2. perfumes novos (semanal): só modelos fora do catálogo, perfumes, no máximo MAX_NOVOS
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": "2026-11-19" }, novos: "2026-11-10" });
  pedidos.length = 0;
  r = await rodar("scrape.mjs", [], { MAX_NOVOS: "1" });
  assert.equal(r.status, 0, r.out);
  b = ler("bruto.json");
  const novo = b.produtos.find((p) => p.id === "9001");
  assert.ok(novo, "modelo novo entra no catálogo");
  assert.deepEqual(novo.o, [[0, 25, "333", HOJE], [1, 27, "444", HOJE]], "ofertas [lojaIdx, usd, cod, t] só das nossas lojas");
  assert.ok(!pedidos.includes("/perfume-marca-x_5001/"), "modelo já conhecido não é aberto");
  assert.ok(!pedidos.some((p) => p.includes("creme")), "item que não é perfume é ignorado");
  assert.ok(!pedidos.includes("/perfume-novo-dois_9002/"), "respeita MAX_NOVOS");
  assert.equal(ler("estado.json").novos, HOJE);
  passo("perfumes novos (ignora conhecidos e não-perfumes, respeita o limite)");

  // 3. HTTP 429: para na hora, sai com 0, ::warning::, dados anteriores mantidos
  grava("estado.json", { varredura: { "loja-alfa": "2026-11-15", "loja-beta": "2026-11-19" }, novos: "2026-11-19" });
  const antesB = readFileSync(arq("bruto.json")), antesE = readFileSync(arq("estado.json"));
  modo = "429";
  r = await rodar("scrape.mjs");
  modo = "normal";
  assert.equal(r.status, 0, "429 sai com código 0");
  assert.match(r.out, /::warning::/);
  assert.ok(readFileSync(arq("bruto.json")).equals(antesB) && readFileSync(arq("estado.json")).equals(antesE), "nada gravado");
  passo("429 (::warning::, código 0, dados mantidos)");
  assert.equal(alertas.length, 1, "um aviso no bloqueio");
  assert.equal(alertas[0].chave, "chave-teste");
  assert.equal(alertas[0].number, "5541000000000");
  assert.ok(alertas[0].text.includes("bloqueou a coleta (HTTP 429"), alertas[0].text);
  passo("aviso por WhatsApp no bloqueio (apikey, número e texto)");

  // leitura muito abaixo da anterior -> aviso
  alertas.length = 0;
  grava("estado.json", { varredura: { "loja-alfa": "2026-11-15", "loja-beta": "2026-11-19" }, novos: "2026-11-19", lidas: { "loja-alfa": 200 } });
  r = await rodar("scrape.mjs");
  assert.equal(r.status, 0, r.out);
  assert.equal(alertas.length, 1, r.out);
  assert.ok(alertas[0].text.includes("Loja Alfa: só 2 ofertas lidas (na vez anterior: 200)"), alertas[0].text);
  assert.equal(ler("estado.json").lidas["loja-alfa"], 2);
  passo("aviso quando a leitura cai para menos da metade (possível mudança no site)");

  // 4. serviço de busca: devolve só campos públicos, aceita kit, ignora creme, guarda descobertos
  grava("data-revenda.json", { atualizadoEm: "2026-11-20T10:00:00Z", produtos: [{ n: "Perfume Um 100ML", i: null, p: 100, r: "0-1", a: HOJE }, { n: "Perfume Dois 100ML", i: null, p: 157, r: "1-2", a: HOJE, h: 1 }] });
  Object.assign(process.env, ENV, { ESPERA_API_MS: "1", DATA_JSON: arq("data-revenda.json"), REVENDEDORES: arq("revendedores.json") });
  const { criarServico } = await import("../server/api.mjs");
  const api = criarServico();
  await new Promise((ok2) => api.listen(0, "127.0.0.1", ok2));
  const URL_API = `http://127.0.0.1:${api.address().port}`;
  const resp = await (await fetch(`${URL_API}/buscar?q=asad`)).json();
  assert.equal((await fetch(`${URL_API}/buscar?q=ab`)).status, 400);
  // ficha olfativa: pela referência; 2º clique vem do cache; kit em oferta solta não tem ficha
  pedidos.length = 0;
  const f1 = (await (await fetch(`${URL_API}/ficha?r=0-111,1-222`)).json()).ficha;
  assert.deepEqual([f1.descricao, f1.publico, f1.lancamento, f1.topo, f1.coracao, f1.fundo, f1.duracao, f1.rastro, f1.usar, f1.acordes],
    ["O Marca X é um perfume âmbar", "Masculino", "2021", ["Pimenta", "Abacaxi"], ["Café"], ["Baunilha"], "Longa Duração", "Forte", ["Inverno"], ["Âmbar"]]);
  assert.deepEqual(pedidos, ["/perfume_5001/"], "1 pedido pela página do modelo");
  await fetch(`${URL_API}/ficha?r=0-111`);
  assert.equal(pedidos.length, 1, "2º clique vem do cache");
  assert.equal((await (await fetch(`${URL_API}/ficha?r=0-777`)).json()).ficha, null, "kit sem ficha");
  passo("ficha olfativa (descrição sem citar a fonte, notas, duração; cache; kit sem ficha)");
  // body splash e loção: "Loção Corporal" anunciado como mist/splash vira "Body Splash"; loção de verdade entra como loção
  const bs = (await (await fetch(`${URL_API}/buscar?q=love%20spell`)).json()).produtos;
  assert.ok(bs.some((p) => p.n === "Victoria's Secret Love Spell Body Splash 250ML" && p.r === "0-901"), JSON.stringify(bs));
  assert.ok(bs.some((p) => p.n === "Victoria's Secret Bare Vanilla Body Splash 250ML" && p.r === "1-881"), JSON.stringify(bs));
  assert.ok(bs.some((p) => p.n === "Loção Corporal Victoria's Secret Amber Romance 236ML" && p.r === "0-903"), "loção entra com o próprio nome");
  passo("body splash e loção (nome certo para cada um)");
  // link de revenda: o lojista cria o link; o catálogo dele vem com a margem e sem o preço de custo
  const post = (corpo) => fetch(`${URL_API}/revenda`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  assert.equal((await post({ nome: "Loja da Ana", whatsapp: "123", margem: 30 })).status, 400, "WhatsApp inválido");
  assert.equal((await post({ nome: "Loja da Ana", whatsapp: "5541999998888", margem: 500 })).status, 400, "margem fora do limite");
  const lk = await (await post({ nome: "Loja da Ana", whatsapp: "+55 (41) 99999-8888", margem: "30" })).json();
  assert.match(lk.codigo, /^loja-da-ana-[0-9a-f]{4}$/, "link com o nome da loja");
  const catTxt = await (await fetch(`${URL_API}/catalogo?loja=${lk.codigo}`)).text(), cat = JSON.parse(catTxt);
  assert.deepEqual(cat.loja, { nome: "Loja da Ana", whatsapp: "5541999998888" });
  assert.deepEqual(cat.produtos.map((p) => p.p), [130, Math.ceil(157 * 1.3)], "preço com a margem do lojista");
  assert.equal(cat.produtos[1].h, 1, "mantém o em alta");
  assert.ok(!/"p":(100|157)\b/.test(catTxt) && !/margem/.test(catTxt), "não expõe o preço de custo nem a margem");
  assert.equal((await fetch(`${URL_API}/catalogo?loja=naoexiste`)).status, 404);
  const semLoja = (await (await fetch(`${URL_API}/buscar?q=asad`)).json()).produtos;
  const comLoja = (await (await fetch(`${URL_API}/buscar?q=asad&loja=${lk.codigo}`)).json()).produtos;
  assert.deepEqual(comLoja.map((p) => p.p), semLoja.map((p) => Math.ceil(p.p * 1.3)), "busca sob demanda com a margem do lojista");
  passo("link de revenda (cria o link, catálogo e busca com a margem do lojista, sem expor o custo)");
  api.close();
  assert.equal(resp.produtos.length, 6, JSON.stringify(resp));
  assert.ok(resp.produtos.some((p) => p.n === "Lattafa Asad Hair Mist 50ML" && p.r === "0-783"), "hair mist entra");
  for (const p of resp.produtos) assert.deepEqual(Object.keys(p).sort(), ["a", "i", "n", "p", "r"]);
  assert.ok(resp.produtos.some((p) => p.n.startsWith("Kit Asad") && p.r === "1-555"));
  assert.ok(resp.produtos.some((p) => p.n === "Kit Perfume Asad Trio Eau de Parfum 100ML" && p.r === "0-777"), "kit em oferta solta entra");
  assert.ok(resp.produtos.some((p) => p.n === "Creme Corporal Asad 280g" && p.r === "0-780"), "creme (modelo) entra");
  assert.ok(resp.produtos.some((p) => p.n === "Creme Hidratante Asad 200g" && p.r === "0-778"), "creme (oferta solta) entra");
  assert.ok(!resp.produtos.some((p) => /Air Freshener|Outra/.test(p.n)), "aromatizador e loja de fora ficam de fora");
  assert.ok(!JSON.stringify(resp).match(/Loja|US\$|usd|margem/i));
  assert.deepEqual(ler("descobertos.json").map((p) => p.id).sort(), ["9005", "9006", "9100", "9101", "o7001", "o7002", "o7005", "o7101"]);
  passo("busca sob demanda (só n/i/p/r/a; kit, creme e hair mist entram; aromatizador não; guarda o achado)");

  // coleta seguinte junta os descobertos ao catálogo
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": HOJE }, novos: HOJE });
  r = await rodar("scrape.mjs");
  assert.equal(r.status, 0, r.out);
  assert.ok(ler("bruto.json").produtos.some((p) => p.id === "9005"));
  assert.ok(!existsSync(arq("descobertos.json")));
  passo("coleta incorpora os perfumes achados pela busca");

  // cotação a cada 3 h: 1 pedido; só republica se mudou; ignora leitura absurda
  const comCotacao = (c) => { const b2 = ler("bruto.json"); b2.cotacao = c; grava("bruto.json", b2); };
  const SAIDA_C = { SAIDA: arq("data-cotacao.json") };
  comCotacao(5.65); pedidos.length = 0;
  r = await rodar("cotacao.mjs", [], SAIDA_C);
  assert.match(r.out, /sem mudança/); assert.equal(pedidos.length, 1); assert.ok(!existsSync(arq("data-cotacao.json")));
  comCotacao(5.5);
  r = await rodar("cotacao.mjs", [], SAIDA_C);
  assert.match(r.out, /5\.5 -> R\$ 5\.65/); assert.equal(ler("bruto.json").cotacao, 5.65); assert.ok(existsSync(arq("data-cotacao.json")));
  comCotacao(8);
  r = await rodar("cotacao.mjs", [], SAIDA_C);
  assert.match(r.out, /ignorada/); assert.equal(ler("bruto.json").cotacao, 8);
  comCotacao(5.65);
  passo("cotação a cada 3 h (1 pedido; republica só se mudou; ignora leitura absurda)");

  // ampliação: resolve as ofertas desconhecidas da varredura (loja de maior prioridade primeiro)
  const brutoAntes = readFileSync(arq("bruto.json"));
  grava("bruto.json", { versao: 1, cotacao: 5.65, produtos: [produtoX(), { id: null, n: "Produto Antigo Feminino 100ML", i: null, o: [[0, 20, "333", "2026-11-10"]] }] });
  const t0 = "2026-11-19";
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": HOJE }, novos: HOJE, fila: [
    { k: "1:444", n: "Perfume Novo Um Feminino 100 ML", usd: 27, t: t0 },      // resolvida pelo modelo aberto para a 0:6666
    { k: "1:4440", n: "Perfume Novo Dois 100ML", usd: 31, t: t0 },             // modelo novo
    { k: "0:7777", n: "Kit Perfume Teste Duo Edp", usd: 40, t: t0, oid: "8001", img: "https://img.exemplo/kit.png" }, // sem modelo
    { k: "0:6666", n: "Perfume Fantasma 100ML", usd: 10, t: t0 },              // modelo encontrado não tem essa oferta
  ] });
  pedidos.length = 0;
  r = await rodar("scrape.mjs", [], { AMPLIACAO_PEDIDOS: "50" });
  assert.equal(r.status, 0, r.out);
  const bam = ler("bruto.json"), eam = ler("estado.json");
  assert.equal(bam.produtos.length, 4, JSON.stringify(bam.produtos));
  const antigo = bam.produtos.find((p) => p.n === "Produto Antigo Feminino 100ML");
  assert.equal(antigo.id, "9001", "o antigo ganhou o número do modelo");
  assert.deepEqual(antigo.o.map((x) => x[2]).sort(), ["333", "444"], "ofertas juntadas, sem duplicar o produto");
  assert.ok(bam.produtos.some((p) => p.id === "9002"), "modelo novo entrou");
  assert.deepEqual(bam.produtos.find((p) => p.id === "o8001")?.o, [[0, 40, "7777", t0]], "kit sem modelo entra como item próprio");
  assert.ok(eam.ampliacao.tentados["0:6666"], "não achou: tenta de novo depois");
  assert.deepEqual(eam.fila.map((f) => f.k), ["0:6666"], "resolvidas saem da fila");
  assert.ok(pedidos.includes("/busca/?q=Fantasma") && pedidos.includes("/busca/?q=Kit%20Teste%20Duo"), JSON.stringify(pedidos));
  assert.match(r.out, /ampliação: 3 ofertas vistas, 5 pedidos, 2 modelos abertos, 1 novos no catálogo, 1 juntados, 1 itens sem modelo, 1 adiadas/);
  passo("ampliação (resolve ofertas desconhecidas: junta o antigo, acrescenta o novo, kit sem modelo, adia o que não achou)");

  // bloqueio no meio da ampliação: o que já foi feito fica guardado (a próxima tentativa continua dali)
  grava("bruto.json", { versao: 1, cotacao: 5.65, produtos: [produtoX(), { id: null, n: "Produto Antigo Feminino 100ML", i: null, o: [[0, 20, "333", "2026-11-10"]] }] });
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": HOJE }, novos: HOJE, fila: [
    { k: "0:6666", n: "Perfume Fantasma 100ML", usd: 10, t: t0 }, { k: "1:4440", n: "Perfume Novo Dois 100ML", usd: 31, t: t0 } ] });
  alertas.length = 0; modo = "429-dois";
  r = await rodar("scrape.mjs", [], { AMPLIACAO_PEDIDOS: "50" });
  modo = "normal";
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning::Fonte de preços respondeu HTTP 429/);
  assert.equal(ler("bruto.json").produtos.find((p) => p.n === "Produto Antigo Feminino 100ML").id, "9001", "progresso guardado");
  assert.deepEqual(ler("estado.json").fila.map((f) => f.k).sort(), ["0:6666", "1:4440"], "a não resolvida continua na fila");
  assert.equal(alertas.length, 1);
  passo("bloqueio no meio da ampliação guarda o progresso");

  // ampliação que não insere nada com muitas ofertas pendentes: aviso no WhatsApp
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": HOJE }, novos: HOJE, fila: [{ k: "0:5555", n: "Creme Dental Sorriso 90g", usd: 2, t: t0 }] });
  alertas.length = 0;
  r = await rodar("scrape.mjs", [], { AMPLIACAO_PEDIDOS: "50", AVISO_FALTAM: "1" });
  assert.equal(r.status, 0, r.out);
  assert.ok(alertas.some((a) => /não inseriu nenhum item/.test(a.text)), JSON.stringify(alertas));
  writeFileSync(arq("bruto.json"), brutoAntes);
  passo("aviso quando a ampliação não insere nada (resultado anormal)");

  // em alta: ordem de relevância da fonte; o que não está no catálogo entra; data.json leva a posição (h)
  modoAlta = true;
  grava("estado.json", { varredura: { "loja-alfa": HOJE, "loja-beta": HOJE }, novos: HOJE });
  r = await rodar("scrape.mjs");
  modoAlta = false;
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /em alta hoje: 2 perfumes \(1 entraram/);
  const ba = ler("bruto.json");
  assert.deepEqual(ba.alta.itens.map((x) => x.id), ["9003", "5001"]);
  assert.deepEqual(ba.produtos.find((p) => p.id === "9003").o, [[1, 26, "991", HOJE]]);
  r = await rodar("publicar.mjs", [], { SAIDA: arq("data-alta.json") });
  const pa = JSON.parse(readFileSync(arq("data-alta.json"), "utf8")).produtos;
  assert.equal(pa.find((p) => p.n.startsWith("Alta Tres")).h, 1);
  assert.equal(pa.find((p) => p.n.startsWith("Marca X")).h, 2);
  assert.equal(pa.filter((p) => p.h).length, 2, "só os em alta têm h");
  passo("em alta do dia (ordem da fonte; novo entra no catálogo; data.json com a posição)");

  // itens sem modelo: mesmo produto em lojas diferentes vira um item só, com nome padronizado; o resto fica separado
  const { arrumarSoltos } = await import("./comum.mjs");
  const soltosT = [
    { id: "o1", n: "Body Mist Armaf I AM Divine - 250ML", i: null, o: [[3, 9, "c1", HOJE]] },               // loja 3
    { id: "o2", n: "Body Mist Feminino Armaf I AM Divine 250ML", i: "foto.png", o: [[0, 8, "m1", HOJE]] },  // loja 0 (prioridade)
    { id: "o3", n: "Krip Sabah - Eau de Parfum - Unisex - 25ML", i: null, o: [[4, 10, "d1", HOJE]] },
    { id: "o4", n: "Krip Sabah - Eau de Parfum - Unissex - 50ML", i: null, o: [[4, 14, "d2", HOJE]] },     // tamanho diferente
    { id: "o5", n: "Kit Perfume Lattafa Asad Edp 100ML", i: null, o: [[0, 40, "m2", HOJE]] },
    { id: "o6", n: "Perfume Lattafa Asad Edt 100ML", i: null, o: [[3, 20, "c2", HOJE]] },                  // EDT
    { id: "o7", n: "Perfume Lattafa Asad Edp 100ML", i: null, o: [[4, 21, "d3", HOJE]] },                  // EDP, sem kit
    { id: "5001", n: "Modelo Normal 100ML", i: null, o: [[0, 1, "x", HOJE]] },                             // com modelo: intocado
  ];
  assert.equal(arrumarSoltos(soltosT), 1, "1 duplicado juntado");
  assert.equal(soltosT.length, 7);
  const bm = soltosT.find((p) => /Divine/.test(p.n));
  assert.equal(bm.n, "Armaf I AM Divine Body Mist Feminino 250ML", "nome padronizado");
  assert.deepEqual(bm.o.map((x) => x[0]).sort(), [0, 3], "ofertas das duas lojas");
  assert.equal(bm.i, "foto.png", "foto da loja de maior prioridade");
  assert.equal(soltosT.filter((p) => /Krip Sabah/.test(p.n)).length, 2, "tamanho diferente não junta");
  assert.equal(soltosT.filter((p) => /Lattafa Asad/.test(p.n)).length, 3, "kit, EDT e EDP continuam separados");
  assert.equal(soltosT.find((p) => p.id === "5001").n, "Modelo Normal 100ML");
  assert.equal(arrumarSoltos(soltosT), 0, "rodar de novo não muda nada");
  passo("itens sem modelo: junta o mesmo produto de lojas diferentes e padroniza o nome (tamanho, kit e EDT separados)");

  // 5. criptografia ida e volta
  const original = readFileSync(arq("bruto.json"));
  r = await rodar("cripto.mjs", ["cifrar"]);
  assert.equal(r.status, 0, r.out);
  const enc = readFileSync(arq("bruto.enc"));
  assert.ok(!enc.includes("Loja Alfa") && !enc.includes("Marca X") && !enc.includes("111"), "cifrado não tem texto puro");
  assert.ok(existsSync(arq("lojas.enc")) && existsSync(arq("estado.enc")));
  rmSync(arq("bruto.json"));
  r = await rodar("cripto.mjs", ["decifrar"]);
  assert.ok(readFileSync(arq("bruto.json")).equals(original), "ida e volta igual");
  r = await rodar("cripto.mjs", ["cifrar"]);
  assert.match(r.out, /bruto: sem mudança/);
  r = await rodar("cripto.mjs", ["decifrar"], { DADOS_CHAVE: randomBytes(32).toString("hex") });
  assert.notEqual(r.status, 0, "chave errada não decifra");
  passo("criptografia AES-256-GCM (ida e volta, chave errada falha, sem regravar sem mudança)");

  // 6. data.json público: preço final, referência, data; sem US$, lojas ou margem
  r = await rodar("publicar.mjs", [], { SAIDA: arq("data.json") });
  assert.equal(r.status, 0, r.out);
  const txt = readFileSync(arq("data.json"), "utf8"), pub = JSON.parse(txt);
  const x = pub.produtos.find((p) => p.n.startsWith("Marca X"));
  assert.equal(x.p, Math.ceil(18.5 * 5.65 * 1.05 * 1.35), "p = ceil(usd × cotação × 1,05 × 1,35)");
  assert.equal(x.r, "0-111,1-222");
  assert.equal(x.a, HOJE);
  assert.deepEqual(Object.keys(pub).sort(), ["atualizadoEm", "produtos"]);
  for (const p of pub.produtos) assert.ok(Object.keys(p).every((k) => ["a", "h", "i", "n", "p", "r"].includes(k)) && ["a", "i", "n", "p", "r"].every((k) => k in p), JSON.stringify(p));
  for (const proibido of ["US$", "usd", "Loja Alfa", "Loja Beta", "margem", "0.35", "cotacao"]) assert.ok(!txt.includes(proibido), `data.json contém "${proibido}"`);
  passo(`data.json público (p=${x.p}, r=${x.r}; sem US$, lojas, margem ou cotação)`);

  console.log(`\nTESTE OK (${ok} verificações)`);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
