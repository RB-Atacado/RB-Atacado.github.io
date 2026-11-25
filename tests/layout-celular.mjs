// Teste de layout (Playwright + Chromium) em 320, 360, 390, 768 e 1280 px:
// nenhum cartão coberto pela busca/cabeçalho ou pela barra, sem rolagem lateral, grade e filtros por largura,
// barra do orçamento no fluxo (sticky) abaixo de 960 px e, no computador, igual ao layout de hoje (fixa).
// Uso: node tests/layout-celular.mjs [pasta-das-capturas]   (PLAYWRIGHT_MODULO = caminho do pacote, opcional)
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULO || "playwright");
const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const CAPTURAS = process.argv[2] || null;
if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
const TIPOS = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

// servidor local só com a pasta site/ (sem o serviço externo, para não depender da internet)
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/config.json") {
    const c = JSON.parse(readFileSync(join(SITE, "config.json"), "utf8"));
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ...c, api: "" }));
  }
  const arq = join(SITE, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
  if (!arq.startsWith(SITE) || !existsSync(arq) || !statSync(arq).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", TIPOS[extname(arq)] || "application/octet-stream");
  res.end(readFileSync(arq));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const TELAS = [[320, 568], [360, 640], [390, 844], [768, 1024], [1280, 800]];
const browser = await chromium.launch();
let falhas = 0;
const confere = (ok, msg) => { console.log(`  ${ok ? "✔" : "✖"} ${msg}`); if (!ok) falhas++; };

for (const [w, h] of TELAS) {
  const celular = w < 600, computador = w >= 960;
  console.log(`\n${w}x${h} (${celular ? "celular" : computador ? "computador" : "tablet"})`);
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: !computador, hasTouch: !computador, deviceScaleFactor: 1 });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  // fotos: imagem local (o layout não pode depender do tamanho da foto);
  // FOTOS_REAIS=1 usa as fotos de verdade, só para as capturas de tela (precisa de internet)
  if (!process.env.FOTOS_REAIS) await page.route(/linodeobjects\.com|\.(png|jpe?g|webp|avif)(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(process.env.FOTOS_REAIS ? 2500 : 300);
  if (CAPTURAS) await page.screenshot({ path: join(CAPTURAS, `${w}-topo.png`) });

  const m = await page.evaluate(async (computador) => {
    const r = (el) => el.getBoundingClientRect();
    const dentro = (el, x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e)); };
    const q = (s) => document.querySelector(s);
    const cards = [...document.querySelectorAll(".card")];
    // cada cartão levado ao meio da tela: topo, meio e pé visíveis (nada por cima)
    const cobertos = [];
    for (const [i, c] of cards.entries()) {
      c.scrollIntoView({ block: "center" });
      const b = r(c), x = b.left + b.width / 2;
      if (!(dentro(c, x, b.top + 4) && dentro(c, x, b.top + b.height / 2) && dentro(c, x, b.bottom - 4))) cobertos.push(i + 1);
    }
    // 1º cartão com a página no topo e o último com a página no fim
    window.scrollTo(0, 0); let b = r(cards[0]);
    const primeiro = dentro(cards[0], b.left + b.width / 2, b.top + 8);
    window.scrollTo(0, document.documentElement.scrollHeight);
    const ult = cards[cards.length - 1]; b = r(ult);
    const ultimo = dentro(ult, b.left + b.width / 2, b.bottom - 4);
    const colunas = new Set(cards.slice(0, 12).map((c) => Math.round(r(c).left))).size;
    const vis = (s) => getComputedStyle(q(s)).display !== "none";
    const topo = (s) => Math.round(r(q(s)).top);
    window.scrollTo(0, 0);
    return {
      cards: cards.length, cobertos, primeiro, ultimo, colunas,
      larguraCartao: Math.round(r(cards[0]).width),
      lateral: document.documentElement.scrollWidth > innerWidth,
      header: getComputedStyle(q("header")).position, cab: getComputedStyle(q(".cab")).position,
      busca: getComputedStyle(q(".busca")).position, buscaH: Math.round(r(q(".busca")).height),
      bar: getComputedStyle(q(".bar")).position, barH: Math.round(r(q(".bar")).height), barVis: vis(".bar"),
      chips: vis(".chips"), genSel: vis("#gen"),
      tipoMarcaJuntos: topo("#tipo") === topo("#brand"), ordenarAbaixo: topo("#sort") > topo("#tipo"),
      quatroNaLinha: ["#gen", "#brand", "#sort"].every((s) => topo(s) === topo("#tipo")),
    };
  }, computador);

  confere(m.cobertos.length === 0, `nenhum dos ${m.cards} cartões coberto${m.cobertos.length ? " (cobertos: " + m.cobertos.join(",") + ")" : ""}`);
  confere(m.primeiro && m.ultimo, "1º cartão visível no topo e último visível no fim da página");
  confere(!m.lateral, "sem rolagem lateral");
  if (celular) {
    confere(m.colunas === 2 || w > 360, `${m.colunas} colunas, cartão de ${m.larguraCartao}px (mín. 136)`);
    confere(m.larguraCartao >= 136 || m.colunas === 1, "cartão com pelo menos 136 px");
    confere(m.chips && !m.genSel, "gênero em botões com rolagem lateral");
    confere(m.tipoMarcaJuntos && m.ordenarAbaixo, "tipo e marca lado a lado; ordenar na linha de baixo (2 por linha)");
  } else if (!computador) {
    confere(m.larguraCartao >= 168, `${m.colunas} colunas, cartão de ${m.larguraCartao}px (mín. 168)`);
    confere(!m.chips && m.genSel && m.quatroNaLinha, "tipo, gênero, marca e ordenar na mesma linha");
  } else {
    confere(m.larguraCartao >= 240, `${m.colunas} colunas, cartão de ${m.larguraCartao}px (mín. 240, como hoje)`);
    confere(!m.chips && m.quatroNaLinha, "busca e os 4 filtros na mesma linha (como hoje)");
  }
  if (!computador) {
    confere(m.header === "static" && m.busca === "sticky" && m.buscaH <= 48, `só a busca presa ao topo (${m.buscaH}px); cabeçalho rola`);
    confere(m.barVis && m.bar === "sticky" && m.barH <= 64, `barra do orçamento no fluxo (position: ${m.bar}, ${m.barH}px)`);
  } else {
    confere(m.cab === "sticky", "cabeçalho inteiro preso ao topo (como hoje)");
    confere(m.bar === "fixed", `barra do orçamento como hoje (position: ${m.bar})`);
  }

  // janelas abrem dentro da tela
  await page.locator(".card button[data-n]").first().click();
  await page.click("#open");
  await page.waitForTimeout(250);
  if (CAPTURAS) await page.screenshot({ path: join(CAPTURAS, `${w}-orcamento.png`) });
  const dlg = await page.evaluate(() => { const b = document.querySelector("#dlg").getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, vh: innerHeight }; });
  confere(dlg.top >= 0 && dlg.bottom <= dlg.vh && dlg.h <= dlg.vh * 0.9 + 1, `orçamento dentro da tela (${Math.round(dlg.h)} de ${dlg.vh}px)`);
  await page.click("#close");
  if (CAPTURAS) {
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(CAPTURAS, `${w}-rolado.png`) });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(falhas ? `\nLAYOUT: ${falhas} falha(s)` : "\nLAYOUT OK");
process.exit(falhas ? 1 : 0);
