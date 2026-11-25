// Monitor de horários de atualização (roda de hora em hora por 7 dias e depois se desliga sozinho).
// Lê a cotação e a 1ª página de ofertas de cada loja na fonte de preços, compara com a leitura anterior
// e registra em que hora os preços mudaram. Dados em MONITOR (padrão: dados/monitor.json), fora do repositório.
//   node scraper/monitor.mjs            -> uma leitura
//   node scraper/monitor.mjs relatorio  -> quadro com os horários em que cada loja costuma mudar preços
import { fileURLToPath } from "node:url";
import { caminho, lerJson, gravarJson, lerLojas, criarCliente, Bloqueio, lerBusca, lerCotacao } from "./comum.mjs";

const ARQ = process.env.MONITOR || caminho("monitor.json");
const DIAS = Number(process.env.MONITOR_DIAS || 7);
const hora = (d = new Date()) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(d);
const quando = (d = new Date()) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(d);

export async function lerUmaVez({ cliente = criarCliente(), log = console.log } = {}) {
  const m = lerJson(ARQ, { inicio: new Date().toISOString(), ultimo: {}, eventos: [], leituras: 0 });
  if ((Date.now() - Date.parse(m.inicio)) / 864e5 > DIAS) { log(`monitor encerrado (passaram ${DIAS} dias); veja o relatório`); return m; }
  const agora = new Date();
  try {
    const cot = lerCotacao((await cliente.get("/")).html);
    if (cot && m.ultimo.cotacao != null && cot !== m.ultimo.cotacao) m.eventos.push({ t: agora.toISOString(), loja: "cotação", mudaram: 1, de: m.ultimo.cotacao, para: cot });
    if (cot) m.ultimo.cotacao = cot;
    for (const loja of lerLojas()) {
      const { itens } = lerBusca((await cliente.get(`/busca/?q=${encodeURIComponent("perfume masculino")}&loja=${loja.slug}&page=1`)).html);
      const atual = Object.fromEntries(itens.filter((x) => x.loja === loja.nome).map((x) => [x.cod, x.usd]));
      const antes = m.ultimo[loja.slug];
      if (antes) {
        const mudaram = Object.keys(atual).filter((c) => c in antes && antes[c] !== atual[c]).length;
        if (mudaram) m.eventos.push({ t: agora.toISOString(), loja: loja.nome, mudaram, comparados: Object.keys(atual).filter((c) => c in antes).length });
      }
      m.ultimo[loja.slug] = atual;
    }
    m.leituras++;
    gravarJson(ARQ, m);
    log(`${quando(agora)} leitura ${m.leituras} | eventos até agora: ${m.eventos.length}`);
  } catch (e) {
    if (e instanceof Bloqueio) { log(`::warning::monitor: fonte respondeu ${e.message}; leitura pulada`); return m; }
    throw e;
  }
  return m;
}

export function relatorio({ log = console.log } = {}) {
  const m = lerJson(ARQ, null);
  if (!m) { log("monitor ainda sem dados"); return; }
  const dias = ((Date.now() - Date.parse(m.inicio)) / 864e5).toFixed(1);
  log(`Monitor desde ${quando(new Date(m.inicio))} (${dias} dias, ${m.leituras} leituras, ${m.eventos.length} mudanças registradas)\n`);
  const porLoja = {};
  for (const e of m.eventos) { (porLoja[e.loja] ||= {})[hora(new Date(e.t))] = ((porLoja[e.loja] ||= {})[hora(new Date(e.t))] || 0) + 1; }
  for (const [loja, horas] of Object.entries(porLoja)) {
    const ordem = Object.entries(horas).sort((a, b) => b[1] - a[1]);
    log(`${loja.padEnd(18)} mudanças por hora (Brasília): ${ordem.map(([h, n]) => `${h}h=${n}`).join("  ")}`);
  }
  if (!m.eventos.length) log("nenhuma mudança de preço registrada até agora");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "relatorio") relatorio();
  else lerUmaVez().catch((e) => { console.error("ERRO:", e.message); process.exitCode = 1; });
}
