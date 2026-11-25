// Coletor leve. Lê scraper/bruto.json e scraper/estado.json (texto puro, fora do git) e:
//  1. varre as buscas por loja das lojas vencidas (agenda em lojas.json, campo frequenciaDias),
//     atualizando preço e data das ofertas já conhecidas (chave lojaIdx:código);
//     ofertas desconhecidas vão para a fila de "novos" e não entram no catálogo nesta varredura;
//  2. 1x por semana, descobre modelos novos nas 10 primeiras páginas de cada loja e abre a página
//     só dos que ainda não estão no catálogo (no máximo MAX_NOVOS);
//  3. junta os perfumes achados pelo serviço de busca (arquivo DESCOBERTOS).
// Se a fonte responder 403/429: para na hora, não grava nada, imprime ::warning:: e sai com código 0.
import { existsSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  caminho, lerJson, gravarJson, lerLojas, hoje, dias, criarCliente, Bloqueio, LimitePedidos,
  lerBusca, lerModelos, lerOfertas, lerCotacao, ofertasDasLojas, normalizar, ehPerfume,
  ofertaPerfume, ehSplash, ehCreme, modeloEhSplash, nomeSplash, termoBusca, arrumarSoltos,
} from "./comum.mjs";
import { alertar } from "./alerta.mjs";

const TERMOS_PADRAO = ["perfume masculino", "perfume feminino", "perfume unissex", "body splash", "body mist", "creme corporal", "locao corporal", "hair mist"];
const POR_PAGINA = 20;
const MAX_NOVOS = Number(process.env.MAX_NOVOS || 150);
const PAGINAS_NOVOS = Number(process.env.PAGINAS_NOVOS || 10);
const DIAS_NOVOS = 7;
const MAX_ALTA = Number(process.env.MAX_ALTA || 40);
const MAX_ALTA_NOVOS = Number(process.env.MAX_ALTA_NOVOS || 20);
const AMPLIACAO_PEDIDOS = Number(process.env.AMPLIACAO_PEDIDOS ?? 3000); // teto de segurança de pedidos por noite
// horário-limite da ampliação (Brasília). Rodando antes dele, a ampliação trabalha até lá; depois dele (ex.: execução manual de dia), vale só o teto.
const AMPLIACAO_ATE = process.env.AMPLIACAO_ATE ?? "06:45";
const AVISO_FALTAM = Number(process.env.AVISO_FALTAM || 500); // abaixo disso, ampliação sem resultado não gera aviso
const menosUmaHora = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${String(Math.max(0, h - 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}`; };
const horaBrasilia = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());

export async function coletar({ cliente = criarCliente(), log = console.log } = {}) {
  const inicio = Date.now();
  const dia = hoje();
  const lojas = lerLojas();
  const nomes = lojas.map((l) => l.nome);
  const termos = lerJson(caminho("termos.json"), TERMOS_PADRAO);
  const bruto = lerJson(caminho("bruto.json"));
  // itens sem modelo: junta os iguais de lojas diferentes e padroniza o nome (antes de montar os índices)
  const juntadosAntes = arrumarSoltos(bruto.produtos);
  if (juntadosAntes) log(`  itens sem modelo: ${juntadosAntes} duplicados entre lojas juntados`);
  const estado = lerJson(caminho("estado.json"), {});
  estado.varredura ||= {};
  estado.fila ||= [];
  estado.lidas ||= {};
  const avisos = [];
  const soLojas = process.env.SO_LOJAS ? process.env.SO_LOJAS.split(",") : null;
  const naoSalvar = process.env.NAO_SALVAR === "1";
  const soAmpliacao = process.env.SO_AMPLIACAO === "1"; // execução manual: só a ampliação (sem varredura nem em alta)

  // índice das ofertas conhecidas: "lojaIdx:cod" -> oferta (array mutável dentro do produto) e -> produto dono
  const indice = new Map(), dono = new Map();
  const ids = new Set(), nomesConhecidos = new Set();
  const registrar = (p) => {
    if (p.id) ids.add(String(p.id));
    nomesConhecidos.add(normalizar(p.n));
    for (const o of p.o) { const k = `${o[0]}:${o[2]}`; indice.set(k, o); dono.set(k, p); }
  };
  for (const p of bruto.produtos) registrar(p);
  // Acrescenta um modelo ao catálogo sem duplicar: se alguma oferta dele já pertence a um produto,
  // junta nesse produto (e grava o número do modelo nele, se faltava). Devolve "novo" ou "juntado".
  const adicionarModelo = (m, o) => {
    const existente = o.map((x) => dono.get(`${x[0]}:${x[2]}`)).find(Boolean);
    if (existente) {
      if (!existente.id) existente.id = String(m.id);
      for (const x of o) if (!indice.has(`${x[0]}:${x[2]}`)) existente.o.push(x);
      registrar(existente);
      return "juntado";
    }
    const prod = { id: String(m.id), n: m.nome, i: m.img, o };
    bruto.produtos.push(prod);
    registrar(prod);
    novosAdicionados++;
    return "novo";
  };
  const tirarDaFila = (o) => { for (const x of o) fila.delete(`${x[0]}:${x[2]}`); };

  // agenda: lojas diárias vencidas + no máximo 1 loja semanal (a mais atrasada)
  const vencidas = lojas
    .map((l, idx) => ({ ...l, idx, freq: Number(l.frequenciaDias || 1), atraso: dias(estado.varredura[l.slug], dia) }))
    .filter((l) => (soLojas ? soLojas.includes(l.slug) : l.atraso >= l.freq));
  const diarias = vencidas.filter((l) => soLojas || l.freq <= 1);
  const semanal = soLojas ? [] : vencidas.filter((l) => l.freq > 1).sort((a, b) => b.atraso - a.atraso).slice(0, 1);
  const varrer = soAmpliacao ? [] : [...diarias, ...semanal];
  const fazerNovos = !soAmpliacao && !soLojas && !semanal.length && dias(estado.novos, dia) >= DIAS_NOVOS;
  log(`Dia ${dia} | lojas a varrer: ${varrer.map((l) => l.nome).join(", ") || "nenhuma"} | perfumes novos: ${fazerNovos ? "sim" : "não"}`);

  const resumo = [];
  const fila = new Map(estado.fila.map((f) => [f.k, f]));
  let cotacao = null, novosAdicionados = 0, alta = null, emAmpliacao = false;
  // grava bruto.json e estado.json com o que já foi feito (ponto de retomada)
  const salvarProgresso = (cot, alt) => {
    if (naoSalvar) return;
    if (cot) { bruto.cotacao = cot; bruto.cotacaoEm = dia; }
    if (alt) bruto.alta = alt;
    estado.fila = [...fila.values()].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 30000);
    gravarJson(caminho("bruto.json"), bruto);
    gravarJson(caminho("estado.json"), estado);
  };
  try {
    cotacao = lerCotacao((await cliente.get("/")).html);

    // em alta: ordem de relevância da lista de perfumes da fonte (muda a cada dia)
    if (!soLojas && !soAmpliacao) {
      const lista = [];
      for (let pag = 1; pag <= 3 && lista.length < MAX_ALTA; pag++) {
        const { itens } = lerModelos((await cliente.get(`/perfume/?page=${pag}`)).html);
        if (!itens.length) break;
        for (const m of itens) if (ehPerfume(m.href) && !lista.some((x) => x.id === m.id)) lista.push(m);
      }
      let abertos = 0, entraram = 0;
      for (const m of lista.slice(0, MAX_ALTA)) {
        if (ids.has(m.id) || nomesConhecidos.has(normalizar(m.nome)) || abertos >= MAX_ALTA_NOVOS) continue;
        abertos++;
        const o = ofertasDasLojas(lerOfertas((await cliente.get(m.href)).html), nomes, dia);
        if (!o.length) continue;
        if (adicionarModelo(m, o) === "novo") entraram++;
        tirarDaFila(o);
      }
      if (lista.length) alta = { dia, itens: lista.slice(0, MAX_ALTA).map((m) => ({ id: m.id, n: normalizar(m.nome) })) };
      log(`  em alta hoje: ${lista.length} perfumes (${entraram} entraram no catálogo agora)`);
    }

    for (const loja of varrer) {
      const vistos = new Set();
      let atualizadas = 0, desconhecidas = 0;
      for (const termo of termos) {
        for (let pag = 1; pag <= 500; pag++) {
          const q = encodeURIComponent(termo);
          const { itens, total } = lerBusca((await cliente.get(`/busca/?q=${q}&loja=${loja.slug}&page=${pag}`)).html);
          for (const it of itens) {
            if (it.loja !== loja.nome) continue;
            const k = `${loja.idx}:${it.cod}`;
            if (vistos.has(k)) continue;
            vistos.add(k);
            const o = indice.get(k);
            if (o) { o[1] = it.usd; o[3] = dia; atualizadas++; }
            else { desconhecidas++; fila.set(k, { k, n: it.nome, usd: it.usd, t: dia, img: it.img || null, oid: it.idOferta || null }); }
          }
          if (!itens.length || pag * POR_PAGINA >= (total || 0)) break;
        }
      }
      const doCatalogo = [...indice.keys()].filter((k) => k.startsWith(loja.idx + ":")).length;
      resumo.push({ loja: loja.nome, slug: loja.slug, ofertasLidas: vistos.size, atualizadas, doCatalogo, desconhecidas });
      // leitura muito abaixo da anterior: provável mudança no site da fonte
      const antes = estado.lidas[loja.slug] || 0;
      if (vistos.size === 0 || (antes >= 100 && vistos.size < antes * 0.5)) {
        avisos.push(`${loja.nome}: só ${vistos.size} ofertas lidas (na vez anterior: ${antes}). A fonte pode ter mudado o site.`);
      }
      estado.lidas[loja.slug] = vistos.size;
      estado.varredura[loja.slug] = dia;
    }

    if (fazerNovos) {
      const candidatos = new Map();
      for (const loja of lojas) {
        for (let pag = 1; pag <= PAGINAS_NOVOS; pag++) {
          const { itens, total } = lerModelos((await cliente.get(`/perfume/?page=${pag}&loja=${loja.slug}`)).html);
          for (const m of itens) {
            if (!ehPerfume(m.href) || ids.has(m.id) || nomesConhecidos.has(normalizar(m.nome)) || candidatos.has(m.id)) continue;
            candidatos.set(m.id, m);
          }
          if (!itens.length || pag * POR_PAGINA >= (total || 0)) break;
        }
      }
      log(`  modelos fora do catálogo nas ${PAGINAS_NOVOS} primeiras páginas: ${candidatos.size} (abrindo até ${MAX_NOVOS})`);
      for (const m of [...candidatos.values()].slice(0, MAX_NOVOS)) {
        const o = ofertasDasLojas(lerOfertas((await cliente.get(m.href)).html), nomes, dia);
        if (!o.length) continue;
        adicionarModelo(m, o);
        tirarDaFila(o);
      }
      estado.novos = dia;
    }

    // ampliação: resolve as ofertas desconhecidas das nossas lojas (lidas na varredura), da loja de maior
    // prioridade para a menor. Para cada uma: busca o nome na fonte, abre o modelo mais provável e confere se o
    // código da oferta está nele (o modelo entra com as ofertas de todas as lojas). Sem modelo e sendo kit/splash/
    // creme, entra como item próprio. Não achou: tenta de novo em 14 dias. Vai até AMPLIACAO_ATE (teto: AMPLIACAO_PEDIDOS).
    if (!soLojas && AMPLIACAO_PEDIDOS > 0) {
      const amp = (estado.ampliacao = { tentados: estado.ampliacao?.tentados || {} });
      const comPrazo = !!AMPLIACAO_ATE && horaBrasilia() < AMPLIACAO_ATE;
      const temTempo = () => !comPrazo || horaBrasilia() < AMPLIACAO_ATE;
      const naoServe = new Set();
      let gastos = 0, vistas = 0, abertos = 0, entraram = 0, juntados = 0, soltos = 0, adiadas = 0;
      const pendentes = [...fila.values()]
        .filter((f) => !indice.has(f.k) && !(amp.tentados[f.k] && dias(amp.tentados[f.k], dia) < 14))
        .sort((a, b) => Number(a.k.split(":")[0]) - Number(b.k.split(":")[0]));
      // guarda o progresso antes e durante a ampliação: se cair no meio, a próxima tentativa continua daqui
      salvarProgresso(cotacao, alta);
      emAmpliacao = true;
      let ultimoSalvo = 0;
      for (const f of pendentes) {
        if (gastos >= AMPLIACAO_PEDIDOS || !temTempo()) break;
        if (gastos - ultimoSalvo >= 200) { salvarProgresso(cotacao, alta); ultimoSalvo = gastos; }
        if (indice.has(f.k)) continue; // já resolvida por um modelo aberto antes
        vistas++;
        const [li, cod] = f.k.split(":"), lojaIdx = Number(li);
        if (!ofertaPerfume(f.n)) { amp.tentados[f.k] = dia; adiadas++; continue; }
        const modelos = lerModelos((await cliente.get(`/busca/?q=${encodeURIComponent(termoBusca(f.n))}`)).html).itens;
        gastos++;
        let tentativas = 0;
        for (const m of modelos) {
          if (indice.has(f.k) || tentativas >= 3 || gastos >= AMPLIACAO_PEDIDOS) break;
          if (ids.has(String(m.id)) || naoServe.has(m.id)) continue;
          const pagina = (await cliente.get(m.href)).html;
          gastos++; abertos++; tentativas++;
          const o = ofertasDasLojas(lerOfertas(pagina), nomes, dia);
          if (!o.length) { naoServe.add(m.id); continue; }
          const nome = m.verificarSplash && modeloEhSplash(lerBusca(pagina).itens.map((x) => x.nome)) ? nomeSplash(m.nome) : m.nome;
          if (adicionarModelo({ ...m, nome }, o) === "novo") entraram++; else juntados++;
          tirarDaFila(o);
        }
        if (indice.has(f.k)) continue;
        if (!modelos.length || /\b(kit|set)\b/i.test(f.n) || ehSplash(f.n) || ehCreme(f.n)) {
          // oferta solta (sem modelo na fonte): entra como item próprio
          adicionarModelo({ id: "o" + (f.oid || `${lojaIdx}-${cod}`), nome: f.n.replace(/^Perfume\s+/i, ""), img: f.img || null }, [[lojaIdx, f.usd, cod, f.t]]);
          fila.delete(f.k);
          soltos++;
        } else { amp.tentados[f.k] = dia; adiadas++; }
      }
      const faltam = [...fila.values()].filter((f) => !indice.has(f.k)).length;
      log(`  ampliação: ${vistas} ofertas vistas, ${gastos} pedidos, ${abertos} modelos abertos, ${entraram} novos no catálogo, ${juntados} juntados, ${soltos} itens sem modelo, ${adiadas} adiadas | ofertas ainda fora do catálogo: ${faltam}`);
      // resultado anormal (não é erro, mas precisa de alguém olhar)
      const inseridos = entraram + juntados + soltos;
      if (faltam >= AVISO_FALTAM && vistas > 0 && inseridos === 0) {
        avisos.push(`A ampliação viu ${vistas} ofertas e não inseriu nenhum item (ainda faltam ${faltam}). Pode ser mudança no site da fonte.`);
      }
      // "parou cedo" só conta as ofertas que ainda podiam ser tentadas (as adiadas esperam 14 dias de propósito)
      const aTentar = [...fila.values()].filter((f) => !indice.has(f.k) && !(amp.tentados[f.k] && dias(amp.tentados[f.k], dia) < 14)).length;
      const terminouCedo = comPrazo && gastos < AMPLIACAO_PEDIDOS && horaBrasilia() < menosUmaHora(AMPLIACAO_ATE) && aTentar >= AVISO_FALTAM;
      if (terminouCedo) avisos.push(`A ampliação parou às ${horaBrasilia()}, bem antes das ${AMPLIACAO_ATE}, com ${aTentar} ofertas ainda a tentar.`);
    }
  } catch (e) {
    const s = cliente.stats();
    if (e instanceof Bloqueio) {
      if (emAmpliacao) salvarProgresso(cotacao, alta); // guarda o que a ampliação já tinha feito
      log(`::warning::Fonte de preços respondeu ${e.message}. Coleta interrompida; o site segue com os dados anteriores (o progresso da ampliação, se houver, ficou guardado).`);
      await alertar(`A fonte de preços bloqueou a coleta (${e.message}). Os preços do site ficaram como estavam.`);
      log(`Pedidos: ${s.pedidos} | ${(s.bytes / 1048576).toFixed(1)} MB | ${Math.round((Date.now() - inicio) / 1000)}s`);
      return { ok: false, bloqueio: true };
    }
    if (e instanceof LimitePedidos) {
      log(`::warning::${e.message}; nada gravado.`);
      imprimirResumo(resumo, s, inicio, log);
      return { ok: false, limite: true, resumo };
    }
    throw e;
  }

  // perfumes achados pelo serviço de busca sob demanda
  const descobertos = process.env.DESCOBERTOS;
  let processando = null;
  if (descobertos && existsSync(descobertos)) {
    processando = descobertos + ".processando";
    renameSync(descobertos, processando);
    for (const p of lerJson(processando, [])) {
      if (ids.has(String(p.id)) || nomesConhecidos.has(normalizar(p.n))) continue;
      adicionarModelo({ id: p.id, nome: p.n, img: p.i }, p.o);
      tirarDaFila(p.o);
    }
  }

  // itens sem modelo que entraram nesta coleta: mesma junção e padronização
  const juntadosDepois = arrumarSoltos(bruto.produtos);
  if (juntadosDepois) log(`  itens sem modelo novos: ${juntadosDepois} duplicados entre lojas juntados`);
  if (cotacao) { bruto.cotacao = cotacao; bruto.cotacaoEm = dia; }
  if (alta) bruto.alta = alta;
  estado.fila = [...fila.values()].sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 30000);
  const s = cliente.stats();
  imprimirResumo(resumo, s, inicio, log);
  for (const a of avisos) log(`::warning::${a}`);
  if (avisos.length) await alertar(avisos.join("\n"));
  log(`Perfumes novos no catálogo: ${novosAdicionados} | total: ${bruto.produtos.length} | fila de ofertas desconhecidas: ${estado.fila.length} | cotação: ${cotacao ?? "não lida"}`);

  if (naoSalvar) {
    log("(teste: nada gravado)");
    if (processando) renameSync(processando, descobertos);
    return { ok: true, resumo };
  }
  gravarJson(caminho("bruto.json"), bruto);
  gravarJson(caminho("estado.json"), estado);
  if (processando) rmSync(processando);
  return { ok: true, resumo };
}

function imprimirResumo(resumo, s, inicio, log) {
  for (const r of resumo) {
    const pct = r.doCatalogo ? ((100 * r.atualizadas) / r.doCatalogo).toFixed(1) : "-";
    log(`  ${r.loja}: ${r.ofertasLidas} ofertas lidas | cobertura do catálogo ${r.atualizadas}/${r.doCatalogo} (${pct}%) | desconhecidas: ${r.desconhecidas}`);
  }
  log(`Pedidos: ${s.pedidos} | ${(s.bytes / 1048576).toFixed(1)} MB | ${Math.round((Date.now() - inicio) / 1000)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  coletar().catch(async (e) => {
    console.error("ERRO:", e.message);
    await alertar(`A coleta de preços falhou: ${e.message}. Os preços do site ficaram como estavam.`);
    process.exitCode = 1;
  });
}
