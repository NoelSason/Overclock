import type { VariationConfig } from "@overclock/contracts";
import type { AppName } from "./variations";

/**
 * CSS for the three apps. Each product has its own palette, type, and layout; the `theme`
 * variation (default / dense / contrast) only overrides CSS custom properties and a few rules.
 */

const BASE = `
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--font);font-size:var(--fs);line-height:1.5;color:var(--fg);background:var(--bg)}
a{color:var(--link);text-underline-offset:2px}
h1{font-family:var(--font-head);font-size:var(--h1);font-weight:var(--h-weight);margin:0 0 .25em;line-height:1.2;color:var(--fg-strong);letter-spacing:var(--h-track)}
h2{font-family:var(--font-head);font-size:1.12em;font-weight:var(--h-weight);margin:1.6em 0 .6em;color:var(--fg-strong)}
p{margin:.4em 0 .9em}
.muted{color:var(--muted)}
.eyebrow{font-size:.8em;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 .3em;font-weight:600}
.id{font-family:var(--mono);font-size:.93em}
table{width:100%;border-collapse:collapse;background:var(--surface)}
caption{text-align:left;caption-side:top;padding:0 0 var(--pad-sm);color:var(--muted);font-size:.9em}
th,td{text-align:left;padding:var(--cell);border-bottom:1px solid var(--line);vertical-align:middle}
thead th{font-size:.76em;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:650;background:var(--thead);white-space:nowrap}
tbody tr:hover{background:var(--row-hover)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.empty{padding:2em;text-align:center;color:var(--muted)}
label{display:block;font-weight:600;font-size:.88em;margin-bottom:.3em;color:var(--fg-strong)}
input[type=text],input[type=search],input[type=password],select,textarea{font:inherit;color:var(--fg);background:var(--input-bg);border:1px solid var(--input-line);border-radius:var(--radius-sm);padding:var(--input-pad);width:100%}
select{padding-right:2em}
textarea{min-height:7.5em;resize:vertical;font-family:var(--font)}
textarea.mono{font-family:var(--mono);font-size:.92em}
input:focus,select:focus,textarea:focus{outline:3px solid var(--focus);outline-offset:0;border-color:var(--accent)}
button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
button{font:inherit;cursor:pointer;border-radius:var(--radius-sm);padding:var(--btn-pad);border:1px solid var(--line-strong);background:var(--surface);color:var(--fg-strong);font-weight:600;line-height:1.3}
button:hover{filter:brightness(.97)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button.primary:hover{filter:brightness(1.08)}
.field{margin-bottom:var(--gap)}
.field-check{display:flex;gap:.55em;align-items:center}
.field-check label{margin:0}
.field-check input{width:1.1em;height:1.1em;accent-color:var(--accent)}
.form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:0 var(--gap-lg)}
.actions{display:flex;gap:1.1em;align-items:center;margin-top:var(--gap)}
.flash{padding:var(--pad-sm) var(--pad);border-radius:var(--radius-sm);background:var(--ok-bg);color:var(--ok-fg);border:1px solid var(--ok-line);margin:0 0 var(--gap);font-weight:600}
.alert{padding:var(--pad);border-radius:var(--radius-sm);background:var(--err-bg);color:var(--err-fg);border:1px solid var(--err-line);margin:0 0 var(--gap)}
.alert strong{display:block;margin-bottom:.2em}
.badge{display:inline-block;padding:.08em .6em;border-radius:999px;font-size:.8em;font-weight:650;background:var(--badge-bg);color:var(--badge-fg);white-space:nowrap;border:1px solid transparent}
.badge.tone-good{background:var(--good-bg);color:var(--good-fg)}
.badge.tone-warn{background:var(--warn-bg);color:var(--warn-fg)}
.badge.tone-bad{background:var(--bad-bg);color:var(--bad-fg)}
.badge.tone-info{background:var(--info-bg);color:var(--info-fg)}
.badge.tone-star{background:var(--star-bg);color:var(--star-fg)}
dl.facts{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.5em 1.75em;margin:0}
dl.facts dt{color:var(--muted);font-size:.9em}
dl.facts dd{margin:0;font-weight:500;color:var(--fg-strong);overflow-wrap:anywhere}
.toolbar{display:flex;flex-wrap:wrap;gap:var(--gap);align-items:flex-end;margin:0 0 var(--gap-lg)}
.toolbar .field{margin:0}
.toolbar .grow{flex:1 1 16rem}
.pager{display:flex;gap:1.1em;align-items:center;justify-content:flex-end;padding:var(--pad-sm) 0;font-size:.92em}
.pager [aria-disabled=true]{color:var(--muted);opacity:.55}
.pageinfo{color:var(--muted)}
.modal-backdrop{position:fixed;inset:0;background:rgba(10,15,30,.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:1em;backdrop-filter:blur(2px)}
.modal{background:var(--surface);color:var(--fg);border-radius:var(--radius);max-width:30rem;width:100%;padding:1.6em 1.6em 1.3em;box-shadow:0 24px 60px rgba(0,0,0,.35);border:1px solid var(--line)}
.modal h2{margin:0 0 .5em;font-size:1.25em}
.modal-actions{display:flex;gap:.75em;justify-content:flex-end;margin-top:1.4em}
[role=tablist]{display:flex;gap:.25em;border-bottom:1px solid var(--line);margin:0 0 var(--gap-lg)}
[role=tab]{border:0;border-bottom:3px solid transparent;border-radius:0;background:none;padding:.55em .95em;color:var(--muted);margin-bottom:-1px}
[role=tab][aria-selected=true]{color:var(--fg-strong);border-bottom-color:var(--accent)}
[role=tabpanel]{min-height:4em}
.message{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:var(--pad);background:var(--quote-bg);border-left:4px solid var(--quote-line);border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-family:var(--font);color:var(--fg)}
ul.notes{list-style:none;padding:0;margin:0 0 var(--gap)}
ul.notes li{padding:var(--pad-sm) var(--pad);border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:.6em;background:var(--surface)}
ul.notes .note-body{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
ul.notes time{display:block;font-size:.8em;color:var(--muted);margin-top:.25em}
.back{display:inline-block;margin-bottom:.9em;font-size:.92em}
.header-row{display:flex;justify-content:space-between;align-items:flex-start;gap:1em;flex-wrap:wrap;margin-bottom:var(--gap-lg)}
.header-row .lede{margin:0;color:var(--muted)}
.button-link{display:inline-block;padding:var(--btn-pad);border-radius:var(--radius-sm);background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;border:1px solid var(--accent)}
.button-link.secondary{background:var(--surface);color:var(--fg-strong);border-color:var(--line-strong)}
.login-form .field{margin-bottom:1em}
.login-form button{width:100%;margin-top:.4em;padding:.7em}
.login-hint{font-size:.85em;color:var(--muted);margin-top:1.2em}
`;

const DENSE = `
body.theme-dense{--fs:13px;--cell:.28em .6em;--pad:.7em;--pad-sm:.35em;--gap:.6em;--gap-lg:.9em;--input-pad:.25em .45em;--btn-pad:.3em .8em;--h1:1.3rem}
body.theme-dense .card,body.theme-dense .panel{padding:.9em}
`;

const CONTRAST = `
body.theme-contrast{--bg:#fff;--surface:#fff;--fg:#000;--fg-strong:#000;--muted:#222;--accent:#000;--on-accent:#fff;--link:#0000d6;--line:#000;--line-strong:#000;--thead:#e8e8e8;--row-hover:#fffbcc;--focus:#ffb000;--input-bg:#fff;--input-line:#000;--badge-bg:#000;--badge-fg:#fff;--good-bg:#000;--good-fg:#fff;--warn-bg:#000;--warn-fg:#fff;--bad-bg:#000;--bad-fg:#fff;--info-bg:#000;--info-fg:#fff;--star-bg:#000;--star-fg:#fff;--quote-bg:#fff;--quote-line:#000;--ok-bg:#fff;--ok-fg:#000;--ok-line:#000;--err-bg:#fff;--err-fg:#000;--err-line:#000;--chrome-bg:#000;--chrome-fg:#fff;--chrome-muted:#fff}
body.theme-contrast a{text-decoration:underline}
body.theme-contrast th,body.theme-contrast td{border-bottom:2px solid #000}
body.theme-contrast input,body.theme-contrast select,body.theme-contrast textarea,body.theme-contrast button{border-width:2px}
body.theme-contrast .card,body.theme-contrast .panel,body.theme-contrast .modal{border:2px solid #000;box-shadow:none}
`;

/* Ledgerline CRM: deep teal header band, centered content cards, serif headings. */
const CRM = `
:root{--font:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;--font-head:Georgia,"Iowan Old Style","Times New Roman",serif;--mono:"SF Mono",Menlo,Consolas,monospace;--fs:15px;--h1:1.85rem;--h-weight:600;--h-track:-.01em;
--bg:#f3f6f5;--surface:#fff;--fg:#26332f;--fg-strong:#0f1f1b;--muted:#5d6d68;--accent:#0f766e;--on-accent:#fff;--link:#0b6b63;--line:#dde6e3;--line-strong:#b9c9c4;--thead:#f1f6f4;--row-hover:#f7fbfa;--focus:#5eead4;
--input-bg:#fff;--input-line:#b9c9c4;--radius:12px;--radius-sm:7px;--cell:.7em 1em;--pad:1.1em;--pad-sm:.55em;--gap:1em;--gap-lg:1.5em;--input-pad:.5em .7em;--btn-pad:.55em 1.2em;
--badge-bg:#e7efed;--badge-fg:#34524b;--good-bg:#dcf3ec;--good-fg:#0d5c50;--warn-bg:#fdf0d5;--warn-fg:#80510b;--bad-bg:#fde3e1;--bad-fg:#9b1c1c;--info-bg:#e0edff;--info-fg:#1e4f99;--star-bg:#f3e8ff;--star-fg:#6b21a8;
--quote-bg:#f4f8f7;--quote-line:#0f766e;--ok-bg:#e3f6ef;--ok-fg:#0b5148;--ok-line:#a6dccb;--err-bg:#fdecea;--err-fg:#8a1c14;--err-line:#f3b7b0;--chrome-bg:#0b3b37;--chrome-fg:#e9fbf7;--chrome-muted:#9fd6cc}
.topbar{background:var(--chrome-bg);color:var(--chrome-fg);box-shadow:0 1px 0 rgba(0,0,0,.15)}
.topbar-inner{max-width:1160px;margin:0 auto;padding:0 1.5em;display:flex;align-items:center;gap:2em;min-height:60px}
.brand{display:flex;align-items:center;gap:.55em;color:var(--chrome-fg);text-decoration:none;font-family:var(--font-head);font-size:1.25em;font-weight:600}
.brand-mark{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#14b8a6,#0f766e);color:#fff;font-size:.85em;font-family:var(--font);font-weight:800;box-shadow:inset 0 -3px 0 rgba(0,0,0,.18)}
.brand-sub{font-family:var(--font);font-size:.62em;letter-spacing:.14em;text-transform:uppercase;color:var(--chrome-muted);font-weight:700;margin-left:.15em}
.topbar nav ul{list-style:none;margin:0;padding:0;display:flex;gap:.3em}
.topbar nav a{display:block;color:var(--chrome-muted);text-decoration:none;padding:.45em .85em;border-radius:6px;font-weight:600;font-size:.94em}
.topbar nav a:hover{color:#fff;background:rgba(255,255,255,.08)}
.topbar nav a[aria-current=page]{color:#fff;background:rgba(255,255,255,.14)}
.user{margin-left:auto;display:flex;align-items:center;gap:.7em;font-size:.9em;color:var(--chrome-muted)}
.user a{color:var(--chrome-fg)}
.avatar{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#134e4a;color:#99f6e4;font-size:.72em;font-weight:800;letter-spacing:.03em}
.wrap{max-width:1160px;margin:0 auto;padding:2em 1.5em 3em}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1.5em;box-shadow:0 1px 2px rgba(16,40,35,.05)}
.card + .card{margin-top:1.25em}
.card table{margin:0}
.foot{max-width:1160px;margin:0 auto;padding:0 1.5em 2em;color:var(--muted);font-size:.82em}
.login-band{background:var(--chrome-bg);height:220px}
.login-card{max-width:400px;margin:-150px auto 3em;background:var(--surface);border-radius:var(--radius);padding:2em;box-shadow:0 18px 40px rgba(11,59,55,.18);border:1px solid var(--line)}
.login-card .brand{color:var(--fg-strong);margin-bottom:1.2em}
.login-card .brand-sub{color:var(--accent)}
`;

/* Parcelpoint Orders: dark slate sidebar, orange accent, dense operational tables. */
const ORDERS = `
:root{--font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-head:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;--fs:14px;--h1:1.5rem;--h-weight:700;--h-track:-.015em;
--bg:#f1f2f4;--surface:#fff;--fg:#1f2937;--fg-strong:#111827;--muted:#6b7280;--accent:#ea580c;--on-accent:#fff;--link:#c2410c;--line:#e5e7eb;--line-strong:#cfd3da;--thead:#f8f9fa;--row-hover:#fff7ed;--focus:#fdba74;
--input-bg:#fff;--input-line:#cfd3da;--radius:6px;--radius-sm:4px;--cell:.55em .85em;--pad:1em;--pad-sm:.5em;--gap:.9em;--gap-lg:1.3em;--input-pad:.45em .6em;--btn-pad:.5em 1.05em;
--badge-bg:#eef0f3;--badge-fg:#374151;--good-bg:#dcfce7;--good-fg:#166534;--warn-bg:#ffedd5;--warn-fg:#9a3412;--bad-bg:#fee2e2;--bad-fg:#991b1b;--info-bg:#dbeafe;--info-fg:#1e40af;--star-bg:#ede9fe;--star-fg:#5b21b6;
--quote-bg:#f9fafb;--quote-line:#ea580c;--ok-bg:#ecfdf3;--ok-fg:#14532d;--ok-line:#a7e3bd;--err-bg:#fef2f2;--err-fg:#991b1b;--err-line:#fecaca;--chrome-bg:#111827;--chrome-fg:#f9fafb;--chrome-muted:#9ca3af}
.pp-shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
.sidebar{background:var(--chrome-bg);color:var(--chrome-fg);display:flex;flex-direction:column;padding:1.2em .9em;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:.6em;color:#fff;text-decoration:none;font-weight:800;font-size:1.12em;letter-spacing:-.01em;padding:.2em .5em 1.4em}
.brand svg{flex:none}
.nav-heading{font-size:.7em;text-transform:uppercase;letter-spacing:.12em;color:#6b7280;margin:.4em .6em .5em;font-weight:700}
.sidebar nav ul{list-style:none;margin:0;padding:0}
.sidebar nav a{display:flex;align-items:center;gap:.6em;color:var(--chrome-muted);text-decoration:none;padding:.55em .7em;border-radius:6px;font-weight:600}
.sidebar nav a:hover{background:#1f2937;color:#fff}
.sidebar nav a[aria-current=page]{background:#1f2937;color:#fff;box-shadow:inset 3px 0 0 var(--accent)}
.sidebar .user{margin-top:auto;border-top:1px solid #1f2937;padding:1em .6em 0;font-size:.85em;color:var(--chrome-muted);display:flex;flex-direction:column;gap:.35em}
.sidebar .user strong{color:#fff}
.sidebar .user a{color:#fdba74}
.pp-content{min-width:0}
.pp-top{background:var(--surface);border-bottom:1px solid var(--line);padding:.8em 2em;display:flex;align-items:center;gap:.8em;color:var(--muted);font-size:.88em}
.pp-top .crumb{font-weight:600;color:var(--fg)}
.pp-main{padding:1.6em 2em 3em;max-width:1240px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1.3em}
.panel + .panel{margin-top:1em}
.panel h2{margin-top:0;font-size:.82em;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1em}
.sections .panel + .panel{margin-top:0}
td .id,td a.id{font-weight:600}
.login-split{display:grid;grid-template-columns:1fr 1fr;min-height:100vh}
.login-art{background:var(--chrome-bg);color:#fff;padding:3em;display:flex;flex-direction:column;justify-content:space-between;background-image:radial-gradient(circle at 80% 20%,rgba(234,88,12,.35),transparent 45%)}
.login-art p{color:var(--chrome-muted);max-width:22em;font-size:1.05em}
.login-pane{display:flex;align-items:center;justify-content:center;padding:2em}
.login-pane .inner{width:100%;max-width:360px}
@media (max-width:760px){.pp-shell{grid-template-columns:1fr}.sidebar{position:static;height:auto}.login-split{grid-template-columns:1fr}.login-art{display:none}}
`;

/* Helpwell Desk: violet gradient header, rounded cards, two-column ticket view. */
const SUPPORT = `
:root{--font:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;--font-head:"Avenir Next","Nunito","Segoe UI",system-ui,sans-serif;--mono:"SF Mono",Menlo,Consolas,monospace;--fs:15px;--h1:1.7rem;--h-weight:700;--h-track:-.01em;
--bg:#f6f4fb;--surface:#fff;--fg:#2e2a3b;--fg-strong:#1c1830;--muted:#6f6987;--accent:#6d28d9;--on-accent:#fff;--link:#6d28d9;--line:#e8e3f3;--line-strong:#cfc6e6;--thead:#faf8fe;--row-hover:#f8f5ff;--focus:#c4b5fd;
--input-bg:#fff;--input-line:#d6cdea;--radius:16px;--radius-sm:10px;--cell:.75em 1em;--pad:1.1em;--pad-sm:.55em;--gap:1em;--gap-lg:1.5em;--input-pad:.55em .75em;--btn-pad:.6em 1.3em;
--badge-bg:#efeaf9;--badge-fg:#4c3d75;--good-bg:#dcf7e9;--good-fg:#11653f;--warn-bg:#fff1d6;--warn-fg:#8a5300;--bad-bg:#ffe1e6;--bad-fg:#a1123a;--info-bg:#e4ecff;--info-fg:#2742a5;--star-bg:#efe4ff;--star-fg:#6d28d9;
--quote-bg:#faf8ff;--quote-line:#a78bfa;--ok-bg:#ecfbf3;--ok-fg:#0f5132;--ok-line:#b0e7cb;--err-bg:#fff0f3;--err-fg:#9f1239;--err-line:#fecdd6;--chrome-bg:linear-gradient(100deg,#4c1d95,#7c3aed);--chrome-fg:#fff;--chrome-muted:#ddd6fe}
.hw-top{background:var(--chrome-bg);color:var(--chrome-fg);padding:0 2em;display:flex;align-items:center;gap:1.5em;min-height:64px}
.brand{display:flex;align-items:center;gap:.5em;color:#fff;text-decoration:none;font-weight:800;font-size:1.2em}
.brand-dot{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fde68a,#f59e0b);box-shadow:0 0 0 4px rgba(255,255,255,.18)}
.brand small{font-weight:600;color:var(--chrome-muted);font-size:.7em;letter-spacing:.04em}
.hw-top nav ul{list-style:none;margin:0;padding:0;display:flex;gap:.4em}
.hw-top nav a{display:block;color:var(--chrome-muted);text-decoration:none;padding:.4em 1em;border-radius:999px;font-weight:700;font-size:.93em}
.hw-top nav a:hover{color:#fff;background:rgba(255,255,255,.12)}
.hw-top nav a[aria-current=page]{background:#fff;color:#4c1d95}
.hw-top .user{margin-left:auto;font-size:.9em;color:var(--chrome-muted);display:flex;gap:.7em;align-items:center}
.hw-top .user a{color:#fff}
.hw-main{max-width:1180px;margin:0 auto;padding:2em 2em 3em}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:1.5em 1.6em;box-shadow:0 2px 10px rgba(76,29,149,.05)}
.card + .card{margin-top:1.2em}
.ticket-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:1.4em;align-items:start}
.ticket-grid > .card + .card{margin-top:0}
.ticket-side{position:sticky;top:1em}
@media (max-width:860px){.ticket-grid{grid-template-columns:1fr}}
.login-bg{min-height:100vh;background:var(--chrome-bg);display:flex;align-items:center;justify-content:center;padding:2em}
.login-card{width:100%;max-width:410px;background:var(--surface);border-radius:22px;padding:2.2em;box-shadow:0 30px 60px rgba(30,10,70,.35)}
.login-card .brand{color:var(--fg-strong);margin-bottom:1em}
.login-card .brand small{color:var(--muted)}
`;

const APP_CSS: Record<AppName, string> = { CRM, Orders: ORDERS, Support: SUPPORT };

export function appCss(app: AppName): string {
  return BASE + APP_CSS[app] + DENSE + CONTRAST;
}

export function themeClass(theme: VariationConfig["theme"]): string {
  return `theme-${theme}`;
}
