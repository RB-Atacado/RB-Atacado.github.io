// Varredura só dos itens sem foto real (não varre o catálogo todo).
//  1. testa no servidor de imagens se cada foto guardada abre (HEAD; não usa a fonte de preços);
//  2. para cada item sem foto ou com foto quebrada, procura o anúncio em cada loja que vende o item, na ordem
//     de prioridade, e guarda a primeira foto que abre (se a loja de referência não tem foto, usa a de outra loja;
//     o site mostra só a foto, nunca a loja de onde ela veio).
// Resultado por item em FOTOS_RESULTADO (padrão dados/fotos-resultado.json), fora do repositório.
//   node scraper/fotos.mjs
import { fileURLToPath } from "node:url";
import { caminho, lerJson, gravarJson, lerLojas, criarCliente, Bloqueio, LimitePedidos, lerBusca, termoBusca, fotoValida } from "./comum.mjs";

const RES = process.env.FOTOS_RESULTADO || caminho("fotos-resultado.json");

async function abre(url) {
  for (let t = 0; t < 2; t++) {
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
      if (r.status === 200) return true;
      if (r.status === 404 || r.status === 403) return false;
    } catch {}
  }
  return null; // não deu para saber (rede): trata como se abrisse, para não apagar foto boa
}

export async function arrumarFotos({ cliente = criarCliente(), log = console.log } = {}) {
  const arqBruto = caminho("bruto.json");
  const bruto = lerJson(arqBruto);
  const lojas = lerLojas();

  // 1. fotos guardadas que não abrem
  const urls = [...new Set(bruto.produtos.map((p) => p.i).filter(fotoValida))];
  const quebradas = new Set();
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < urls.length) { const u = urls[k++]; if ((await abre(u)) === false) quebradas.add(u); }
  }));
  const todosAfetados = bruto.produtos.filter((p) => !fotoValida(p.i) || quebradas.has(p.i));
  // item em que a fonte não tinha foto em nenhuma loja: só procura de novo depois de 7 dias
  const anterior = lerJson(RES, { resultado: [] });
  const semFotoNaFonte = new Map((anterior.resultado || []).filter((x) => /^\(d/.test(x.causa) && x.em).map((x) => [String(x.id), x.em]));
  const afetados = todosAfetados.filter((p) => { const em = semFotoNaFonte.get(String(p.id)); return !em || Date.now() - Date.parse(em) > 7 * 864e5; });
  log(`fotos testadas: ${urls.length} | quebradas: ${quebradas.size} | itens sem foto real: ${todosAfetados.length} | a procurar agora: ${afetados.length}`);

  // 2. procura a foto nos anúncios de cada loja que vende o item
  const resultado = [];
  let pedidos = 0, parouPor = null;
  const busca = async (q, slug) => { pedidos++; return lerBusca((await cliente.get(`/busca/?q=${encodeURIComponent(q)}&loja=${slug}`)).html).itens; };
  try {
    for (const p of afetados) {
      const antes = p.i || null;
      const r = { n: p.n, id: p.id, r: p.o.map((o) => `${o[0]}-${o[2]}`).join(","), antes, quebrada: !!(antes && quebradas.has(antes)), lojas: [] };
      for (const o of [...p.o].sort((a, b) => a[0] - b[0])) {
        const loja = lojas[o[0]];
        if (!loja) continue;
        let it = null;
        for (const q of [...new Set([p.nomeOriginal, termoBusca(p.n)].filter(Boolean))]) {
          it = (await busca(q, loja.slug)).find((x) => x.loja === loja.nome && String(x.cod) === String(o[2]));
          if (it) break;
        }
        const st = !it ? "anúncio não encontrado" : !fotoValida(it.img) ? "anúncio sem foto" : (await abre(it.img)) === false ? "foto do anúncio não abre" : "ok";
        r.lojas.push({ loja: o[0], st });
        if (st === "ok") { p.i = it.img; r.depois = it.img; r.deOutraLoja = o[0] !== Math.min(...p.o.map((x) => x[0])); break; }
      }
      r.causa = r.depois ? (r.quebrada ? "(b) endereço quebrado" : "(a) sem endereço, a fonte tem")
        : r.lojas.every((l) => l.st === "anúncio sem foto") ? "(d) a fonte não tem foto em nenhuma loja"
        : "(d?) anúncio não localizado em alguma loja";
      // foto quebrada e nenhuma substituta: tira o endereço (o site mostra o cartão neutro direto)
      if (!r.depois && r.quebrada) p.i = null;
      r.em = new Date().toISOString();
      resultado.push(r);
    }
  } catch (e) {
    if (e instanceof Bloqueio) { parouPor = `fonte respondeu ${e.message}`; log(`::warning::Fonte de preços respondeu ${e.message}; parei e guardei o que foi feito`); }
    else if (e instanceof LimitePedidos) parouPor = "limite de pedidos";
    else throw e;
  }
  gravarJson(arqBruto, bruto);
  // guarda também os "sem foto na fonte" das vezes anteriores que não foram procurados agora (para o intervalo de 7 dias)
  const agora = new Set(resultado.map((x) => String(x.id)));
  const aindaSem = new Set(todosAfetados.map((p) => String(p.id)));
  const herdados = (anterior.resultado || []).filter((x) => /^\(d/.test(x.causa) && !agora.has(String(x.id)) && aindaSem.has(String(x.id)));
  gravarJson(RES, { quando: new Date().toISOString(), pedidos, parouPor, quebradas: quebradas.size, afetados: todosAfetados.length, resultado: [...resultado, ...herdados] });
  const c = resultado.reduce((a, x) => ((a[x.causa] = (a[x.causa] || 0) + 1), a), {});
  log(`pedidos à fonte: ${pedidos} | itens resolvidos: ${resultado.filter((x) => x.depois).length} de ${resultado.length}${parouPor ? " | parou: " + parouPor : ""}`);
  for (const [k2, v] of Object.entries(c)) log(`  ${k2}: ${v}`);
  return resultado;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  arrumarFotos().catch((e) => { console.error("ERRO:", e.message); process.exitCode = 1; });
}
