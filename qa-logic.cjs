const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\bboot\(\);\s*$/, '');
const elements = new Map();
const makeElement = (id = '') => ({
  id, value: '', textContent: '', innerHTML: '', style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {}, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }
});
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
  querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return makeElement(); }, body: makeElement('body')
};
const storage = new Map();
const context = {
  console, document,
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  firebase: { initializeApp() {}, database() { return { ref() { return {}; } }; }, auth() { return {}; } },
  Blob, URL, FileReader: function FileReader() {}, confirm: () => true, prompt: () => '',
  navigator: { userAgent: '' }, window: { addEventListener() {} }, setTimeout, clearTimeout,
  matchMedia: () => ({ matches: true }), performance, requestAnimationFrame: callback => callback(performance.now() + 1000)
};
vm.createContext(context);
vm.runInContext(source, context);
const result = vm.runInContext(`(() => {
  const sample = [
    {fbKey:'a',status:'Fullført',prioritet:'Høy',frist:'2026-01-01',dato:'2026-01-01',fullfortDato:'2026-08-01',eier:'Tony Danielsen',kategori:'HMS',tittel:'Ferdig'},
    {fbKey:'b',status:'Aktiv',prioritet:'Høy',frist:'2026-08-10',dato:'2026-07-01',eier:'Tony Danielsen',kategori:'KF',tittel:'Forfalt'},
    {fbKey:'c',status:'Stanset',prioritet:'Kritisk',frist:'2026-08-01',dato:'2026-06-01',eier:'Kenneth Nordbakk',kategori:'HMS',tittel:'Stanset'},
    {fbKey:'d',status:'Innmeldt',prioritet:'Middels',frist:'2026-08-18',dato:'2026-08-01',eier:'Erling Magnussen',kategori:'Kvalitet',tittel:'Snart'}
  ];
  tasks = sample;
  const defaultsBefore = [getView('mine'), getView('all')];
  localStorage.setItem('opex_view_mine', 'list');
  activeUser = 'Tony Danielsen';
  const newCompletion = completionMetadata({});
  const legacyCompletion = completionMetadata({fullfortDato:'2026-08-01',arkivertDato:'2026-08-01'});
  const stored = {...sample[0],livssyklus:'Arkivert',arkivert:true};
  const trashed = {...stored,livssyklus:'Papirkurv',papirkurv:true};
  const testItem = {...sample[1],fbKey:'test',miljo:'Test'};
  document.getElementById('dashOwner').value = 'Kenneth Nordbakk';
  document.getElementById('dashScope').value = 'all';
  renderWelcome(counts(sample.filter(t => t.eier === 'Kenneth Nordbakk')), 0);
  const personalizedWelcome = document.getElementById('welcomeReward').innerHTML;
  return {
    counts: counts(sample),
    completedDate: dateState(sample[0]),
    stoppedStatus: computedStatus(sample[2]),
    actionRequired: sample.map(isActionRequired),
    defaultsBefore,
    rememberedMine: getView('mine'),
    highBacklog: sample.filter(t => priorityMatch(t,'high') && statusMatch(t,'restanse')).map(t => t.fbKey),
    trend: backlogTrend(sample).map(x => ({label:x.label,created:x.created,completed:x.completed,backlog:x.backlog})),
    newCompletion,
    legacyCompletion,
    lifecycleLabels: [visibleLabel(stored), visibleLabel(trashed)],
    storedFlags: [isCompletedStored(stored), isCompletedStored(trashed)],
    archiveForOwner: archiveVisibleTasks([stored,trashed,testItem],false).map(t => t.fbKey),
    archiveForAdmin: archiveVisibleTasks([stored,trashed,testItem],true).map(t => t.fbKey),
    legacyClosed: normStatus('Avvist'),
    ideaMeta: lifecycleMetadata('Stanset', {}),
    closedMeta: lifecycleMetadata('Avsluttet', {}),
    lifecycleArchiveForOwner: archiveVisibleTasks([
      stored,
      {...sample[2],livssyklus:'Idebank',arkivert:true},
      {...sample[2],fbKey:'closed',status:'Avvist',livssyklus:'Avsluttet',arkivert:true},
      trashed,
      testItem
    ],false).map(t => t.fbKey),
    activeKeys: activeTasks().map(t => t.fbKey),
    categoryFocus: categoryInsightData(sample.filter(t => !isTerminal(t))).focus,
    excelStatus: excelRows([{...sample[2],status:'Avvist'}])[0].Status,
    trashDefault: trashConfirmEnabled(),
    personalizedWelcome
  };
})()`, context);

const expected = {
  high: 1, backlog: 2, completedLabel: 'Fullført 1. aug. 2026', stoppedStatus: 'Stanset',
  actionRequired: 'false,true,false,true', defaults: 'cards,list', remembered: 'list', highBacklog: 'b'
};
const checks = [
  [result.counts.high === expected.high, 'ferdige/stansede tiltak telles ikke som høy risiko'],
  [result.counts.backlog === expected.backlog, 'restansen teller bare uavsluttede tiltak'],
  [result.completedDate.label === expected.completedLabel, 'fullførte tiltak vises med fullførtdato'],
  [result.stoppedStatus === expected.stoppedStatus, 'stansede tiltak blir ikke forfalt'],
  [result.actionRequired.join(',') === expected.actionRequired, 'handlingsfilteret avgrenser riktig'],
  [result.defaultsBefore.join(',') === expected.defaults, 'standardvisninger er Mine=kort og Alle=liste'],
  [result.rememberedMine === expected.remembered, 'visningsvalg huskes per side'],
  [result.highBacklog.join(',') === expected.highBacklog, 'høy-prioritet-filteret utelater avsluttede tiltak'],
  [Boolean(result.newCompletion.fullfortDato && result.newCompletion.fullfortTidspunkt), 'ny fullføring får både dato og tidspunkt'],
  [result.legacyCompletion.fullfortDato === '2026-08-01' && result.legacyCompletion.fullfortTidspunkt === null, 'historiske datoer beholdes uten oppdiktet klokkeslett'],
  [result.lifecycleLabels.join(',') === 'Fullført,Flyttet til papirkurv', 'fullførte og slettede tiltak har tydelige ulike etiketter'],
  [result.storedFlags.join(',') === 'true,false', 'papirkurv regnes ikke som fullførte lagrede tiltak'],
  [result.archiveForOwner.join(',') === 'a', 'tiltakseiere ser bare fullførte tiltak i historikken'],
  [result.archiveForAdmin.join(',') === 'a,a,test', 'administrator ser fullførte tiltak, papirkurv og testdata'],
  [result.legacyClosed === 'Avsluttet', 'gammel status Avvist vises som Avsluttet'],
  [result.ideaMeta.livssyklus === 'Idebank' && Boolean(result.ideaMeta.stansetDato && result.ideaMeta.stansetTidspunkt), 'stanset tiltak får Idébank og tidsstempel'],
  [result.closedMeta.livssyklus === 'Avsluttet' && Boolean(result.closedMeta.avsluttetDato && result.closedMeta.avsluttetTidspunkt), 'avsluttet tiltak får egen lagring og tidsstempel'],
  [result.lifecycleArchiveForOwner.join(',') === 'a,c,closed', 'alle godkjente brukere ser Fullførte, Idébank og Avsluttede'],
  [result.activeKeys.join(',') === 'b,d', 'stansede og avsluttede tiltak tas ut av aktive lister'],
  [result.categoryFocus.k === 'KF', 'kategorirådet prioriterer risiko i aktive tiltak'],
  [result.excelStatus === 'Avsluttet', 'Excel-eksport bruker oppdatert statusnavn'],
  [result.trashDefault === true, 'bekreftelse før papirkurv er på som standard'],
  [result.personalizedWelcome.includes('Kenneth') && !result.personalizedWelcome.includes('Tony'), 'velkomstmeldingen følger valgt ansvarlig']
];
checks.forEach(([ok, label]) => { if (!ok) throw new Error(`FEIL: ${label}\n${JSON.stringify(result, null, 2)}`); console.log(`OK: ${label}`); });
console.log(JSON.stringify(result, null, 2));
