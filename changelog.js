// Changelog shown in Settings -> Ändringslogg. Pure data, no deps, newest version first.
// Every release MUST add an entry here (version = package.json "version", ISO date, short
// Swedish bullets about what changed for the user). tests/changelog.test.js enforces it.
// Loaded by renderer.html before settingsView.js.
(function () {
  'use strict';

  const CHANGELOG = [
    { version: '0.30.0', date: '2026-10-22', items: [
      'Text med flera rader som klistras in vid PowerShell-prompten slås ihop till en rad, så att första raden inte körs direkt.',
      'Kommentarsrader, tomma rader och radfortsättningar (`) tas bort vid sammanslagningen.',
      'Text som inte går att slå ihop säkert (ett # utanför citattecken före sista raden, here-strings, strängar över flera rader) klistras in rad för rad som förut.',
      'Claude, Copilot och program med bracketed paste får texten som den är.',
      'Ny inställning "Flerradig inklistring" (Terminal): "Som en rad" eller "Rad för rad".',
      'Nytt val "Copy as one line" i terminalens högerklicksmeny.'
    ] },
    { version: '0.29.0', date: '2026-10-22', items: [
      'Ny ikon för deployer bredvid Inställningar: visar om en deploy kör, väntar på godkännande eller har misslyckats.',
      'Håll muspekaren över ikonen för senaste deployen per repo och miljö, med status, körning, commit, vem och när. Klicka för att fästa listan.',
      'Miljöer som väntar på ditt godkännande kan godkännas eller avvisas direkt, med en valfri kommentar.',
      'Välj repon under Inställningar → GitHub → Deployer att följa (owner/repo eller owner/repo@fil.yml).',
      'Windows-notis när en ny deploy väntar på ditt godkännande (går att stänga av).'
    ] },
    { version: '0.28.0', date: '2026-10-21', items: [
      'Ny sektion "Ändringslogg" i Inställningar: alla versioner med sammanfattade ändringar, nyaste överst.',
      'Versionen du kör är märkt "Nuvarande"; de tre senaste versionerna visas utfällda.'
    ] },
    { version: '0.27.0', date: '2026-10-21', items: [
      'Flikgrupper som i Chrome: högerklicka på en flik och välj "Lägg till i ny grupp", eller lägg den i en befintlig grupp.',
      'Gruppens rubrik går att fälla ihop och ut; hopfälld visas antalet flikar.',
      'Gruppmenyn låter dig byta namn och färg, öppna en ny flik i gruppen, dela upp eller stänga gruppen.',
      'Flikar i en grupp hålls samman vid dragning, och Ctrl+Tab hoppar över hopfällda flikar.',
      'Grupper (namn, färg, hopfälld) sparas mellan starter.'
    ] },
    { version: '0.26.0', date: '2026-10-21', items: [
      'Ny inställning "Återuppta Claude-sessioner vid start" (Claude): Claude-sessioner som körde i terminalflikar när appen stängdes startar om med --resume vid första prompten.',
      'Bara sessioner som faktiskt var igång vid stängning återupptas.',
      'Knappen "Resume Claude session" fungerar som förut.'
    ] },
    { version: '0.25.0', date: '2026-10-20', items: [
      'Klickbara länkar (OSC 8) i terminalen. Webblänkar frågar alltid först och visar vart de går.',
      'Mappar i worktree-mappen öppnas direkt i Utforskaren; andra mappar frågar först.',
      'Hybridinmatningen: klick på statusraden under inmatningen träffar rätt länk.'
    ] },
    { version: '0.24.1', date: '2026-10-20', items: [
      'Hybridinmatningen lämnar inte längre ett tomrum ovanför Claudes statusrad.',
      'Statusraden och agentlistan sitter direkt under texten, och ledig yta hamnar nederst intill appens inmatning.',
      'Länkar, markering och högerklicksklistra in fungerar som vanligt.'
    ] },
    { version: '0.24.0', date: '2026-10-19', items: [
      'Nytt apptema: Spiris, med varma mörka ytor och dämpad korall som accentfärg.'
    ] },
    { version: '0.23.0', date: '2026-10-19', items: [
      'Välj apptema under Inställningar → Allmänt → Apptema: Nuvarande, Fjord, Ljung, Djuphav, Grafit, Kontrast och Kobolt.',
      'Temat byts direkt och påverkar färger, hörnradie och ikon i titelraden.',
      'Terminalens färgschema kan följa apptemat ("Följ apptema").'
    ] },
    { version: '0.22.0', date: '2026-10-19', items: [
      'Klistra in eller släpp bilder i repo-anteckningar, med miniatyrer och förhandsvisning.',
      'Dra en bild från en anteckning till Claude-chatten eller inmatningen så bifogas den.',
      'Kopiera en anteckning tar med bildernas sökvägar. Bilder sparas lokalt, aldrig i repot.'
    ] },
    { version: '0.21.3', date: '2026-10-19', items: [
      'Knappen "Öppna på github.com" i listorna öppnar nu själva sidan i stället för att bara ladda om vyn.'
    ] },
    { version: '0.21.2', date: '2026-10-19', items: [
      'Begär en Copilot-granskning direkt från PR-vyn ("Request Copilot review" / "Re-request").',
      'Visas bara när du har rätt behörighet, och knappen kan inte skickas två gånger.',
      'Om Copilot inte kan granska visas en förklaring.'
    ] },
    { version: '0.21.1', date: '2026-10-19', items: [
      'PR-tidslinjen visar nu kommentarer på enskilda kodrader, även Copilots, som kort per fil och rad.',
      'Lösta och föråldrade trådar markeras, och lösta trådar börjar hopfällda.'
    ] },
    { version: '0.21.0', date: '2026-10-19', items: [
      'Ny inställningssektion "Flöden": rita orchestrate och egna flöden som en canvas med faser och steg.',
      'Steg kan vara agenter (med egen modell och "kör igen vid fynd"), vanliga steg, villkor eller "fråga mig".',
      'Flöden sparas automatiskt, och "Testkör" simulerar ett flöde utan att köra något.',
      '"Skriv SKILL.md" skapar en skill från flödet efter förhandsvisning och bekräftelse.'
    ] },
    { version: '0.20.0', date: '2026-10-19', items: [
      'Mac Codes egna fel sparas som anteckningar i repot mac-code, med källa, meddelande och stack.',
      'Samma fel igen räknas upp i stället för att skapa en ny anteckning.',
      'Felen loggas också i errors.log i användarmappen.'
    ] },
    { version: '0.19.0', date: '2026-10-19', items: [
      'Ny sektion "Claude-konfiguration" i Inställningar för globala agenter, skills och hooks i ~/.claude.',
      'Agenter: välj modell, öppna, skapa från mall eller ta bort.',
      'Skills: öppna, skapa eller ta bort; länkade skills visas som "länkad".',
      'Hooks: lägg till, ändra, ta bort och slå av/på. Ändringar säkerhetskopieras och farliga kommandon kräver bekräftelse.'
    ] },
    { version: '0.18.2', date: '2026-10-19', items: [
      'Merge-dialogen förväljer nu "Create a merge commit" och behåller branchen.',
      'Båda går att ställa in under Inställningar → GitHub ("Förvalt merge-sätt", "Ta bort branchen efter merge").'
    ] },
    { version: '0.18.1', date: '2026-10-19', items: [
      'GitHub-fönstret loggar in först i stället för att visa 404 för privata repon, och inloggningen sparas.'
    ] },
    { version: '0.18.0', date: '2026-10-19', items: [
      'PR- och ärendevyn visar hela GitHub-tidslinjen: commits, granskningar, kommentarer, labels, merge och mer.',
      'Copilot-status på öppna PR:er: "Copilot reviewing…", "review requested" eller "review failed".',
      'Granskarlistan visar nu även Copilot och andra botar.'
    ] },
    { version: '0.17.3', date: '2026-10-16', items: [
      'Visar "Done HH:MM" efter varje Claude-tur, i inmatningen och på agentkorten.',
      'Flikar som återställs räknas som repo-användning först när de används.'
    ] },
    { version: '0.17.2', date: '2026-10-16', items: [
      'Windows-notiser visas nu på riktigt (rätt app-id), och Mac Code finns i Windows notislista.'
    ] },
    { version: '0.17.1', date: '2026-10-16', items: [
      'Notiser kommer nu från orchestrate-flödet: "Flow done" och "Flow needs you". Klick öppnar flödet.',
      'Slut på notisspam varje gång Claude blev klar. "Claude needs permission" finns kvar för chattar.',
      'Hybridinmatningen skickar Claudes egna genvägar vidare: Shift+Tab, Ctrl+O, Ctrl+T och Ctrl+B.',
      'Den blinkande texten "Claude working / idle" i statusfältet är borta.'
    ] },
    { version: '0.17.0', date: '2026-10-16', items: [
      'Meny med dina vanligaste repon i flikraden: öppna i ny flik som skal, Claude-chatt eller Claude i terminal.',
      'GitHub-sidofältet har en väljare "Öppna flikar…" för att byta till repot bakom en öppen flik.'
    ] },
    { version: '0.16.0', date: '2026-10-15', items: [
      'GitHub öppnas som ett stort överlägg i stället för egen flik (valbart under Inställningar → GitHub).',
      'Esc stänger ett lager i taget, och Ctrl+Shift+G växlar.',
      'Merga pull requests direkt: dialogen visar checks, granskning och tillåtna metoder, med val för att ta bort branchen och auto-merge.',
      'Utkast och konflikter blockeras med en förklaring.'
    ] },
    { version: '0.15.1', date: '2026-10-15', items: [
      'Flikraden kan rullas med mushjulet när många flikar är öppna.',
      'Den aktiva fliken scrollas alltid in i bild, så en ny flik hamnar inte utanför skärmen.'
    ] },
    { version: '0.15.0', date: '2026-10-15', items: [
      'Inställningar öppnas med Ctrl+, eller kugghjulet i titelraden.',
      'Kategorier: Allmänt, Terminal, Claude, GitHub, Editor och Explorer, Kortkommandon och Om.',
      'Ändringar sparas direkt och gäller genast där det går.',
      'Exportera och importera inställningar. Känsliga värden som sökvägar importeras aldrig.'
    ] },
    { version: '0.14.4', date: '2026-10-15', items: [
      'Repo-anteckningarna ligger nu längst ned i Explorer-fältet i stället för över terminalen, och höjden går att ändra.',
      'Kopiera-knapp för alla anteckningar som Markdown, och en kopieringsikon på varje anteckning.'
    ] },
    { version: '0.14.3', date: '2026-10-13', items: [
      'Återuppta en terminalflikas senaste Claude-session med ett klick via fältet "Resume Claude session".',
      'Claude-sessioner avslutas pålitligare när appen stängs, så återupptagningsraden sparas.',
      'Förbrukning, överlämning och sessionsålder fungerar nu även i mappar med punkter eller understreck.'
    ] },
    { version: '0.14.2', date: '2026-10-13', items: [
      'Skarpare säkerhet i auto-läget: kommandon läses i bitar och bara helt ofarliga kommandon godkänns automatiskt, annars frågar appen.'
    ] },
    { version: '0.14.1', date: '2026-10-13', items: [
      'Säkrare GitHub-fönster: nekar enhetsbehörigheter och håller navigeringen på GitHub.',
      'Auto-läget är striktare med gh-kommandon och frågar vid riskfyllda skal-konstruktioner.'
    ] },
    { version: '0.14.0', date: '2026-10-13', items: [
      'Slår ihop GitHub-funktionerna från 0.13.0 med orchestrate-flödesspåraren.'
    ] },
    { version: '0.13.0', date: '2026-10-13', items: [
      'Flödesspårare: se var en Claude-session är i orchestrate-flödet (Plan, Skeptic, Build, Verify, Done).',
      'Historik i inmatningen: pil upp hämtar tidigare skickade meddelanden.',
      'GitHub-flik (Ctrl+Shift+G) med inkorg, pinnade repon, PR:er, ärenden och Actions, via gh CLI.',
      'github.com-länkar öppnas i appen, och statusfältet visar PR-pill med checks eller "+ PR".',
      'Fix/Review with Claude och Checkout skapar en egen worktree.',
      'Redigerare för secrets och variabler, samt repo-anteckningar (Ctrl+Shift+N).'
    ] },
    { version: '0.12.2', date: '2026-09-25', items: [
      'Pågående Claude-sessioner avslutas när appen stängs, så resume-raden hamnar i den sparade historiken.'
    ] },
    { version: '0.12.1', date: '2026-09-25', items: [
      'Sparad session skrivs säkrare med reservkopia, så en avbruten stängning inte längre raderar den.'
    ] },
    { version: '0.12.0', date: '2026-09-02', items: [
      'Rutnätsflik ("Skapa grid"): visa flera flikar sida vid sida, dra in flikar och klicka på en ruta för fokus.',
      'Git-gren i statusfältet går att byta direkt.',
      'Fix: länkar som bryts över två rader i terminalen öppnas i sin helhet.',
      'Fix: rullningslisten går att ta tag i igen i hybridläget.'
    ] },
    { version: '0.11.2', date: '2026-08-19', items: [
      'Inmatningen i varje pane ligger nu i en egen ruta under terminalen och tar inte längre terminalens höjd.',
      'Högre standardhöjd på inmatningsfältet.'
    ] },
    { version: '0.11.1', date: '2026-08-18', items: [
      'Fix: klistra in i inmatningen hamnade i terminalen.',
      'Kommandopaletten visas framför terminalen.',
      'Återupptagna sessioner öppnas i terminalen som standard.',
      'Fix: inmatningen vägrade skicka för namngivna Claude-sessioner.'
    ] },
    { version: '0.11.0', date: '2026-08-18', items: [
      'Varje terminalpane med Claude får en egen inmatning, så båda halvorna av en delning kan styras samtidigt.',
      'Ctrl+Tab och Ctrl+Shift+Tab växlar flik, även inifrån terminalen.',
      'Ångra och gör om i inmatningen (Ctrl+Z, Ctrl+Y).',
      'Ctrl+R och Ctrl+Shift+R laddar inte längre om appen och raderar panelerna.'
    ] },
    { version: '0.10.0', date: '2026-08-18', items: [
      'Egna /kommandon i Claude-inmatningen: genvägar som expanderas till text, till exempel /cp eller /pr.',
      'Skriv /commands för att redigera dem. De visas överst i /-paletten och fungerar i både chatt och terminal.'
    ] },
    { version: '0.9.0', date: '2026-08-18', items: [
      'Hybridinmatning för Claude i terminalen: appens egen inmatning ersätter Claudes, med bildklistring och /-palett.',
      'Chattpaneler får ett Instant/Smooth-val för hur text strömmar in.',
      'Länkar i chattens text är klickbara, och inmatningen visar hur länge turen har pågått.'
    ] },
    { version: '0.8.0', date: '2026-08-18', items: [
      'Planförbrukning (5 timmar och vecka) visas i inmatningen och i statusfältet.',
      'Modellväljaren listar även äldre modellversioner, med ett val för 1M kontext.',
      'Jämnare strömning av text.',
      'Fix: 1M-chattar visade 200k, text slutade rulla i inaktiva flikar och modellbyte kunde döda panelen.'
    ] },
    { version: '0.7.1', date: '2026-08-17', items: [
      'Inbyggda Claude-chattpaneler med verktygskort, diffar, bilder, /-palett, modellväljare och kontextmätare.',
      'Ny design: rundade flikar, bredare Explorer, agentpanel till höger och omgjort statusfält.',
      'Behörighetsläge med fyra nivåer, där appen frågar innan Claude får köra något som kräver godkännande.',
      'Terminallåda i chatten (Ctrl+`) och /mcp för att hantera MCP-servrar.'
    ] },
    { version: '0.5.2', date: '2026-05-25', items: [
      'Ctrl+Z ångrar den senaste inmatade biten i terminalen, en bit i taget.'
    ] },
    { version: '0.5.1', date: '2026-05-25', items: [
      'Stöd för GitHub Copilot CLI: öppna Copilot från en mapp, med egna rader och sparade sessioner.',
      'Överlämning från Claude till Copilot: ett kompakt underlag (2k, 6k eller 12k tokens) skickas till en ny Copilot-session.',
      'Klistra in och Ctrl+Backspace fungerar bättre, även inne i Claude.',
      'Sparade sessioner går att fälla ihop, och en stängd flik ger fokus åt den senast använda.'
    ] },
    { version: '0.3.1', date: '2026-05-08', items: [
      '"Öppna i Utforskaren" i mappmenyn, och "Go here in shell" rensar skärmen efteråt.',
      'Fix: modellnamnet kunde visas som "[^".'
    ] },
    { version: '0.3.0', date: '2026-05-08', items: [
      'Dra flikar för att ändra ordning, och nya flikar får automatiskt en egen färg.',
      'Flikar sparas mellan starter, med mapp, titel och färg samt synlig historik.',
      'Bibliotek med sparade Claude-sessioner att byta namn på, återuppta och ta bort.',
      'Snabbare, utan flimmer i agentpanelen.'
    ] },
    { version: '0.2.0', date: '2026-05-08', items: [
      'Delade paneler: dela åt höger eller nedåt, dra i skiljelisten och stäng med Ctrl+Shift+W.',
      'Ctrl+C kopierar markering, annars avbryter; Ctrl+V klistrar in.',
      'Inbyggd Monaco-editor för filer, med klickbara filsökvägar i terminalen.',
      'Windows-notiser när Claude är klar, och färgvarning för kontextanvändning.'
    ] },
    { version: '0.1.0', date: '2026-05-08', items: [
      'Första versionen: ett modernt PowerShell-fönster för Windows med flikar.',
      'Riktig PowerShell 7 per flik (annars Windows PowerShell), med Windows Terminal-färger.',
      'Eget titelfält, statusfält och kortkommandon för att öppna och stänga flikar (Ctrl+Shift+T / Ctrl+Shift+W).'
    ] }
  ];

  if (typeof window !== 'undefined') window.CHANGELOG = CHANGELOG;
  if (typeof module !== 'undefined' && module.exports) module.exports = CHANGELOG;
})();
