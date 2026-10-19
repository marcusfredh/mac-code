// App themes: colors, corner radius and the titlebar brand icon. Plain script, no deps.
// Loaded by renderer.html (before settingsView.js, which applies the saved theme) and
// required by main.js for the window's startup background. The 'default' theme must
// stay identical to the :root tokens in renderer.html and WINDOWS_TERMINAL_THEME in
// renderer.js; tests/appThemes.test.js pins that.
(function () {
  'use strict';

  // Compact source data; expanded to full themes below.
  const RAW = [
  {
    id: 'default', name: 'Nuvarande', radius: 6, fgRgb: '255,255,255', ink: '#001a26',
    icon: '<svg viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="2.5" stroke="currentColor" stroke-width="1.1"/><path d="M3.8 6l2.4 2-2.4 2M8 10h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ui: { bg: '#0c0c0c', chrome: '#171717', panel: '#1a1a1a', tabActive: '#232323', card: '#141414', cardHdr: '#181818', composer: '#1c1c1c',
      accent: '#60cdff', accentHi: '#8ddaff', green: '#4ec994', cyan: '#61d6d6', amber: '#d7ba7d', purple: '#b393ff', red: '#e74856' },
    term: {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#0c0c0c',
      selectionBackground: '#3a3d41', black: '#0c0c0c', red: '#c50f1f', green: '#13a10e',
      yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd',
      white: '#cccccc', brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
      brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6',
      brightWhite: '#f2f2f2'
    }
  },
  {
    id: 'fjord', name: 'Fjord', radius: 6, fgRgb: '222,233,242', ink: '#04211e',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 11.5L5.5 4l2.6 4.4L10 6l4.5 5.5"/><path d="M1.5 14c1.2-.8 2.3-.8 3.5 0s2.3.8 3.5 0 2.3-.8 3.5 0 1.7.6 2.5.3"/></svg>',
    ui: { bg: '#0d1217', chrome: '#131a21', panel: '#161e26', tabActive: '#1f2a35', card: '#111820', cardHdr: '#151d26', composer: '#18212b',
      accent: '#5ad1c4', accentHi: '#8fe3d9', green: '#7dd3a0', cyan: '#6cc6e0', amber: '#e3c07e', purple: '#9fa8ff', red: '#f07178' },
    term: {
      background: '#0d1217', foreground: '#c5d1dc', cursor: '#8fe3d9', cursorAccent: '#0d1217',
      selectionBackground: '#23384a', black: '#1b2530', red: '#e0646f', green: '#6fc795',
      yellow: '#dcb86b', blue: '#5b9fe0', magenta: '#b48ee6', cyan: '#4fc4c4',
      white: '#c5d1dc', brightBlack: '#5c6b7a', brightRed: '#f28b93', brightGreen: '#92dcb0',
      brightYellow: '#ecd08e', brightBlue: '#82b8f0', brightMagenta: '#c9aaf0', brightCyan: '#7ad9d4',
      brightWhite: '#eef3f7'
    }
  },
  {
    id: 'heather', name: 'Ljung', radius: 10, fgRgb: '242,226,234', ink: '#2e0a1a',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.6" r="1.6"/><circle cx="6.2" cy="6.8" r="1.6"/><circle cx="9.8" cy="6.8" r="1.6"/><circle cx="8" cy="9.6" r="1.6"/><path d="M8 11.2v3.3M8 13l2-1.2"/></svg>',
    ui: { bg: '#141013', chrome: '#1b161a', panel: '#1e181d', tabActive: '#2b2229', card: '#171216', cardHdr: '#1b151a', composer: '#211a20',
      accent: '#f4a3c0', accentHi: '#f8c4d6', green: '#9ccfa4', cyan: '#8cc8d4', amber: '#f1c58e', purple: '#c8a6f0', red: '#f07a8a' },
    term: {
      background: '#141013', foreground: '#dccdd5', cursor: '#f8c4d6', cursorAccent: '#141013',
      selectionBackground: '#3c2a36', black: '#261e24', red: '#e86f82', green: '#8fc59a',
      yellow: '#e8bb7c', blue: '#8aa9e0', magenta: '#d897c8', cyan: '#7fbfcc',
      white: '#dccdd5', brightBlack: '#6e5d68', brightRed: '#f592a3', brightGreen: '#acd7b4',
      brightYellow: '#f2d09e', brightBlue: '#a9c1ec', brightMagenta: '#e8b2da', brightCyan: '#a0d2dc',
      brightWhite: '#f8eef3'
    }
  },
  {
    id: 'deep', name: 'Djuphav', radius: 3, fgRgb: '222,230,250', ink: '#2b0a05',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 2.4-1 3.4-.6"/><path d="M1.5 10c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 2.4-1 3.4-.6"/><circle cx="12" cy="13.2" r=".9" fill="currentColor" stroke="none"/><circle cx="9.6" cy="14" r=".6" fill="currentColor" stroke="none"/></svg>',
    ui: { bg: '#0a1020', chrome: '#0f1628', panel: '#121a2e', tabActive: '#1b2541', card: '#0d1424', cardHdr: '#111a2c', composer: '#152036',
      accent: '#ff8a73', accentHi: '#ffab9a', green: '#5fd4a0', cyan: '#5cc8f0', amber: '#f5c56b', purple: '#a99cff', red: '#ff6b81' },
    term: {
      background: '#0a1020', foreground: '#c8d2ea', cursor: '#ffab9a', cursorAccent: '#0a1020',
      selectionBackground: '#22325a', black: '#16203a', red: '#f2687a', green: '#57c795',
      yellow: '#e8b85c', blue: '#5b8def', magenta: '#a58af0', cyan: '#4fbfe6',
      white: '#c8d2ea', brightBlack: '#56638a', brightRed: '#ff8b99', brightGreen: '#7fd9af',
      brightYellow: '#f2cd85', brightBlue: '#85aaf5', brightMagenta: '#c0aaf6', brightCyan: '#7dd3f0',
      brightWhite: '#eef2fb'
    }
  },
  {
    id: 'graphite', name: 'Grafit', radius: 4, fgRgb: '232,233,236', ink: '#2a1e00',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M8 1.5l5.5 6.5L8 14.5 2.5 8z"/><path d="M2.5 8h11M8 1.5L5.8 8 8 14.5 10.2 8z"/></svg>',
    ui: { bg: '#111214', chrome: '#18191c', panel: '#1b1c20', tabActive: '#25272b', card: '#151619', cardHdr: '#191a1d', composer: '#1e1f23',
      accent: '#f2c14e', accentHi: '#f7d683', green: '#8bd49c', cyan: '#79c7d6', amber: '#e8a95b', purple: '#b9a3f0', red: '#ef6f6c' },
    term: {
      background: '#111214', foreground: '#d5d7db', cursor: '#f7d683', cursorAccent: '#111214',
      selectionBackground: '#34363c', black: '#1f2125', red: '#e5646a', green: '#86c98f',
      yellow: '#e9bc4c', blue: '#6f9fe0', magenta: '#b996e6', cyan: '#6ec2cf',
      white: '#d5d7db', brightBlack: '#686c74', brightRed: '#f08a8e', brightGreen: '#a6dcab',
      brightYellow: '#f5d27c', brightBlue: '#96bbee', brightMagenta: '#cfb3ef', brightCyan: '#94d6df',
      brightWhite: '#f3f4f6'
    }
  },
  {
    id: 'contrast', name: 'Kontrast', radius: 2, fgRgb: '255,255,255', ink: '#000000',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none"/></svg>',
    ui: { bg: '#000000', chrome: '#0e0e0e', panel: '#111111', tabActive: '#222222', card: '#0a0a0a', cardHdr: '#121212', composer: '#161616',
      accent: '#ffffff', accentHi: '#ffffff', green: '#3ddc84', cyan: '#3fd0e0', amber: '#ffc940', purple: '#c792ff', red: '#ff5c5c' },
    term: {
      background: '#000000', foreground: '#e6e6e6', cursor: '#ffffff', cursorAccent: '#000000',
      selectionBackground: '#333333', black: '#1a1a1a', red: '#ff5c5c', green: '#3ddc84',
      yellow: '#ffc940', blue: '#5c9dff', magenta: '#e070ff', cyan: '#3fd0e0',
      white: '#d9d9d9', brightBlack: '#808080', brightRed: '#ff8a8a', brightGreen: '#6ff0a8',
      brightYellow: '#ffdb7a', brightBlue: '#8bbcff', brightMagenta: '#eda0ff', brightCyan: '#7fe6f0',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'cobalt', name: 'Kobolt', radius: 8, fgRgb: '226,228,245', ink: '#0b1040',
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/></svg>',
    ui: { bg: '#0b0b10', chrome: '#111118', panel: '#14141c', tabActive: '#1d1d29', card: '#0f0f16', cardHdr: '#13131b', composer: '#181822',
      accent: '#7b8cff', accentHi: '#a3afff', green: '#5ee0a0', cyan: '#4fd6f0', amber: '#ffc66b', purple: '#d58cff', red: '#ff6b8b' },
    term: {
      background: '#0b0b10', foreground: '#cdd0e8', cursor: '#a3afff', cursorAccent: '#0b0b10',
      selectionBackground: '#25285a', black: '#1a1a26', red: '#f0607e', green: '#54cf92',
      yellow: '#f0bb5e', blue: '#6f80ff', magenta: '#c77dff', cyan: '#46c8e3',
      white: '#cdd0e8', brightBlack: '#5a5d7a', brightRed: '#ff8aa2', brightGreen: '#82e3b2',
      brightYellow: '#f8d18a', brightBlue: '#9aa6ff', brightMagenta: '#dba6ff', brightCyan: '#7cdcf0',
      brightWhite: '#f0f1fb'
    }
  }
  ];

  const REF_RADIUS = 6; // today's typical corner radius, the radius-k = 1 reference

  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const fgHex = (rgb) => '#' + rgb.split(',').map((x) => hex2(Number(x))).join('');
  // '#rrggbb' + alpha 0..1 -> '#rrggbbaa' (Monaco takes hex only)
  const withAlpha = (h, a) => h + hex2(a * 255);

  // Blend fg (an "r,g,b" string) into a hex surface by pct (0..1), for stripes that sit a shade above it.
  function mixFg(hex, fgRgb, pct) {
    const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const b = fgRgb.split(',').map((x) => parseInt(x, 10));
    return '#' + a.map((v, i) => hex2(v + (b[i] - v) * pct)).join('');
  }

  function buildVars(t, isDefault) {
    const u = t.ui, f = t.fgRgb.split(',').map((x) => x.trim()).join(', ');
    return {
      '--bg': u.bg, '--chrome': u.chrome, '--panel': u.panel, '--tab-active': u.tabActive,
      '--menu': isDefault ? '#232323' : u.tabActive,
      '--card': u.card, '--card-hdr': u.cardHdr,
      '--code-bg': isDefault ? '#0f0f0f' : u.card,
      '--composer': u.composer,
      '--dialog': isDefault ? '#1f1f1f' : u.tabActive,
      '--term-bg': t.term.background,
      '--fg': `rgba(${f}, 0.78)`, '--fg-strong': fgHex(t.fgRgb), '--fg-dim': `rgba(${f}, 0.62)`,
      '--fg-muted': `rgba(${f}, 0.50)`, '--fg-faint': `rgba(${f}, 0.35)`,
      '--line': `rgba(${f}, 0.07)`, '--line-soft': `rgba(${f}, 0.055)`,
      '--fill': `rgba(${f}, 0.05)`, '--fill-hover': `rgba(${f}, 0.07)`,
      '--accent': u.accent, '--accent-hi': u.accentHi, '--accent-ink': isDefault ? '#06212f' : t.ink,
      // Default keeps the exact literals these spots had before themes existed.
      '--accent-ink-strong': isDefault ? '#002233' : t.ink, '--resume-ink': isDefault ? '#000000' : t.ink,
      '--link-hover': isDefault ? '#9adcff' : u.accentHi,
      '--seg-active': isDefault ? '#2e2e2e' : mixFg(u.tabActive, t.fgRgb, 0.04),
      '--stripe-a': isDefault ? '#2b2b2b' : mixFg(u.tabActive, t.fgRgb, 0.03),
      '--stripe-b': isDefault ? '#333333' : mixFg(u.tabActive, t.fgRgb, 0.07),
      '--swatch-none': isDefault ? '#2a2a2a' : mixFg(u.tabActive, t.fgRgb, 0.03),
      '--green': u.green, '--cyan': u.cyan, '--amber': u.amber, '--purple': u.purple, '--red': u.red,
      '--radius-k': isDefault ? '1' : String(Math.round((t.radius / REF_RADIUS) * 100) / 100)
    };
  }

  function buildMonaco(t, isDefault) {
    if (isDefault) return { base: 'vs-dark', inherit: true, rules: [], colors: {} }; // plain vs-dark, as before
    const u = t.ui, fg = fgHex(t.fgRgb), sel = t.term.selectionBackground;
    return {
      base: 'vs-dark', inherit: true, rules: [],
      colors: {
        'editor.background': u.bg,
        'editor.foreground': t.term.foreground,
        'editorGutter.background': u.bg,
        'minimap.background': u.bg,
        'editor.lineHighlightBackground': withAlpha(fg, 0.05),
        'editorCursor.foreground': u.accent,
        'editor.selectionBackground': sel,
        'editor.inactiveSelectionBackground': withAlpha(sel, 0.55),
        'editorLineNumber.foreground': withAlpha(fg, 0.35),
        'editorLineNumber.activeForeground': withAlpha(fg, 0.78),
        'editorIndentGuide.background1': withAlpha(fg, 0.07),
        'editorWhitespace.foreground': withAlpha(fg, 0.2),
        'editorWidget.background': u.tabActive,
        'editorSuggestWidget.background': u.tabActive,
        'scrollbarSlider.background': withAlpha(fg, 0.14),
        'scrollbarSlider.hoverBackground': withAlpha(fg, 0.24)
      }
    };
  }

  const APP_THEMES = RAW.map((t) => {
    const isDefault = t.id === 'default';
    return {
      id: t.id, name: t.name,
      radiusK: isDefault ? 1 : Math.round((t.radius / REF_RADIUS) * 100) / 100,
      icon: t.icon,
      vars: buildVars(t, isDefault),
      term: t.term,
      monaco: buildMonaco(t, isDefault)
    };
  });

  function themeById(id) {
    return APP_THEMES.find((t) => t.id === id) || APP_THEMES[0];
  }

  let activeId = 'default';

  // Monaco theme name for an app theme, defining it first. 'vs-dark' for the default.
  function appMonacoTheme(id) {
    const t = themeById(id == null ? activeId : id);
    if (t.id === 'default') return 'vs-dark';
    const name = 'mac-' + t.id;
    try { if (window.monaco && window.monaco.editor) window.monaco.editor.defineTheme(name, t.monaco); } catch (_) {}
    return name;
  }

  function applyAppTheme(id) {
    const t = themeById(id);
    activeId = t.id;
    if (typeof document === 'undefined') return t;
    const style = document.documentElement.style;
    for (const [k, v] of Object.entries(t.vars)) style.setProperty(k, v);
    const brand = document.querySelector('.titlebar-brand svg');
    if (brand && brand.dataset.theme !== t.id) {
      const tmp = document.createElement('div');
      tmp.innerHTML = t.icon;
      const svg = tmp.firstElementChild;
      if (svg) { svg.dataset.theme = t.id; brand.replaceWith(svg); }
    }
    try {
      if (window.monaco && window.monaco.editor) window.monaco.editor.setTheme(appMonacoTheme(t.id));
    } catch (_) {}
    return t;
  }

  if (typeof window !== 'undefined') {
    window.APP_THEMES = APP_THEMES;
    window.applyAppTheme = applyAppTheme;
    window.appMonacoTheme = appMonacoTheme;
    window.themeById = themeById;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { APP_THEMES, themeById };
})();
