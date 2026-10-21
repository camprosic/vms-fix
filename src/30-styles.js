  // --- styles -----------------------------------------------------------
  // All scoped under #d0007-root so we dont fight the portals bootstrap. The
  // green is close to the SJA green, the rest is whatever didnt look terrible.
  const CSS = `
#d0007-root{position:fixed;inset:0;z-index:2147483000;background:#f3f5f2;color:#1d2a1f;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden}
#d0007-root *{box-sizing:border-box}
#d0007-root a{color:#2f6b3a}
#d0007-root header{background:#1f4d2b;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#d0007-root header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
#d0007-root header .sp{flex:1}
#d0007-root .btn{border:1px solid #cfd8d0;background:#fff;color:#1d2a1f;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;font-size:13px}
#d0007-root .btn:hover{background:#eef3ee}
#d0007-root header .btn{background:transparent;color:#fff;border-color:rgba(255,255,255,.35)}
#d0007-root header .btn:hover{background:rgba(255,255,255,.12)}
#d0007-root nav{display:flex;gap:4px;padding:8px 16px 0;background:#fff;border-bottom:1px solid #dfe5e0;overflow-x:auto}
#d0007-root nav button{border:0;background:none;padding:8px 12px;font:inherit;font-weight:600;color:#55675a;cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap}
#d0007-root nav button.on{color:#1f4d2b;border-bottom-color:#1f4d2b}
#d0007-root main{flex:1;overflow:auto;padding:16px;-webkit-overflow-scrolling:touch}
#d0007-root .wrap{max-width:1100px;margin:0 auto}
#d0007-root .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
#d0007-root .seg{display:inline-flex;border:1px solid #cfd8d0;border-radius:6px;overflow:hidden;background:#fff}
#d0007-root .seg button{border:0;background:none;padding:6px 10px;font:inherit;font-size:13px;cursor:pointer;color:#3a4a3d}
#d0007-root .seg button.on{background:#1f4d2b;color:#fff}
#d0007-root input[type=search]{border:1px solid #cfd8d0;border-radius:6px;padding:7px 10px;font:inherit;min-width:200px;flex:1;background:#fff}
#d0007-root .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
#d0007-root .stat{background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:10px 12px}
#d0007-root .stat b{display:block;font-size:22px;line-height:1.1;color:#1f4d2b}
#d0007-root .stat.warn b{color:#b23a2a}
#d0007-root .stat span{font-size:12px;color:#5b6b5e}
#d0007-root .card{background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:12px 14px;margin-bottom:10px}
#d0007-root .card .t{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
#d0007-root .card h3{margin:0;font-size:15px;flex:1 1 240px}
#d0007-root .card .when{font-weight:600;color:#1f4d2b;white-space:nowrap}
#d0007-root .meta{color:#5b6b5e;font-size:13px;margin-top:4px}
#d0007-root .pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11.5px;font-weight:600;background:#e8eee9;color:#2f4a35;vertical-align:middle}
#d0007-root .pill.red{background:#fbe4e0;color:#9a2b1d}
#d0007-root .pill.amber{background:#fdeccd;color:#8a5a00}
#d0007-root .pill.green{background:#dcefdf;color:#1f5a2c}
#d0007-root .pill.grey{background:#e7e9e7;color:#4f5a51}
#d0007-root .staff{margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
#d0007-root .track{flex:1 1 140px;height:8px;background:#e6ebe6;border-radius:999px;overflow:hidden;min-width:100px}
#d0007-root .track i{display:block;height:100%;background:#2f6b3a}
#d0007-root .track i.red{background:#c2452f}
#d0007-root .detail{margin-top:10px;border-top:1px dashed #dfe5e0;padding-top:10px}
#d0007-root table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}
#d0007-root th,#d0007-root td{text-align:left;padding:7px 8px;border-bottom:1px solid #e7ebe7;vertical-align:top}
#d0007-root th{font-size:12px;color:#5b6b5e;font-weight:600;background:#f7f9f7;position:sticky;top:0;cursor:pointer;user-select:none;white-space:nowrap}
#d0007-root th.sorted:after{content:" ▾";opacity:.6}
#d0007-root th.sorted.asc:after{content:" ▴"}
#d0007-root td.n,#d0007-root th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
#d0007-root .tbl{background:#fff;border:1px solid #dfe5e0;border-radius:8px;overflow:auto;max-height:70vh}
#d0007-root tr.row{cursor:pointer}
#d0007-root tr.row:hover td{background:#f4f8f4}
#d0007-root .muted{color:#7a877c}
#d0007-root .err{background:#fbe4e0;color:#8a2416;border:1px solid #f1c3bb;border-radius:8px;padding:10px 12px;margin-bottom:12px}
#d0007-root .load{padding:30px;text-align:center;color:#5b6b5e}
#d0007-root .load:before{content:"";display:inline-block;width:18px;height:18px;border:3px solid #cfd8d0;border-top-color:#1f4d2b;border-radius:50%;animation:d7spin .8s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes d7spin{to{transform:rotate(360deg)}}
#d0007-root .two{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:900px){#d0007-root .two{grid-template-columns:3fr 2fr}}
#d0007-root .side{background:#fff;border:1px solid #dfe5e0;border-radius:8px;padding:12px 14px;align-self:start;position:sticky;top:0}
#d0007-root .side h3{margin:0 0 6px;font-size:15px}
#d0007-root .side h4{margin:12px 0 6px;font-size:12px;color:#5b6b5e;text-transform:uppercase;letter-spacing:.4px}
#d0007-root ul.plain{list-style:none;margin:0;padding:0}
#d0007-root ul.plain li{padding:4px 0;border-bottom:1px solid #eef1ee;display:flex;justify-content:space-between;gap:10px}
#d0007-root footer{font-size:11.5px;color:#7a877c;padding:6px 16px;border-top:1px solid #dfe5e0;background:#fff}
#d0007-launch{position:fixed;right:16px;bottom:16px;z-index:2147482000;background:#1f4d2b;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:600 13px -apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
`;
  // Screens push their own css onto this so they dont have to edit this file.
  const CSS_PARTS = [CSS];
