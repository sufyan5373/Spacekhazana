/* ============================================================================
 *  SpaceKhazana PDF Viewer  (pdf-viewer.js)
 *  Self-contained, vanilla JS. Loads PDF.js from cdnjs on first use.
 *
 *  Usage:
 *    SKPdfViewer.open({ id, name, url, downloadUrl });
 *
 *  Features: continuous scroll, lazy page rendering, zoom (buttons, fit width,
 *  ctrl+wheel, pinch), rotate, page jump, text selection, search with
 *  highlights, thumbnails sidebar, remembers last page per file, download,
 *  print, keyboard shortcuts, dark/light reading mode, mobile friendly.
 *
 *  Annotations: highlight text (4+ colours), add typed text (Latin / Urdu /
 *  any script), eraser, undo. Annotations autosave per file in this browser
 *  and can be baked into a real PDF with "Save PDF" (uses pdf-lib, loaded
 *  lazily from cdnjs). Print uses the annotated copy when annotations exist.
 * ========================================================================== */
(function () {
    'use strict';

    const PDFJS_VER = '3.11.174';
    const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.js`;
    const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`;
    const LS_PAGE = 'sk_pdf_last_page_';
    const LS_MODE = 'sk_pdf_reader_mode';
    const PDFLIB_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
    const LS_ANN = 'sk_pdf_ann_';
    const LS_PREFS = 'sk_pdf_ann_prefs';
    const MIN_SCALE = 0.25, MAX_SCALE = 5;
    const HL_COLORS = ['#ffe94d', '#c9ff72', '#7ee787', '#33e5ff', '#6cb8ff', '#ddabff', '#ff8cff', '#ff9ecb', '#ffa97a', '#ffb454', '#ff6666', '#fff480', '#ffbf00', '#b6f0ff'];
    const TX_COLORS = ['#1a73e8', '#068a1c', '#ffbf00', '#ff6200', '#d93025', '#c035c0', '#9747ff',
                       '#33e5ff', '#c9ff72', '#fff480', '#ffa97a', '#ff6666', '#ff8cff', '#ddabff',
                       '#ffffff', '#cccccc', '#aaaaaa', '#777777', '#444444', '#2e2e2e', '#000000'];
    const MARK_NAME = { x: 'crossmark', check: 'checkmark', dot: 'dot', circle: 'circle (drag to size it)' };
    const TX_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
    const INK_W = [2, 4, 8];
    const SPACINGS = [0, 0.5, 1, 2, 4, -0.5];
    const LS_PAL = 'sk_pdf_pal_pos';
    const LS_VIEW = 'sk_pdf_view';
    const FONTKIT_SRC = 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js';
    const NON_LATIN = /[^\x20-\x7E\xA0-\xFF\n\r\t]/;
    const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;


    const ICON_SPLIT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
    const ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M12 5v14M9 19h6"/></svg>';
    const ICON_SAVE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
    const ICON_SWAP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"/><path d="M3 7h18"/><path d="M7 21l-4-4 4-4"/><path d="M21 17H3"/></svg>';

    /* ───────────── CSS ───────────── */
    const CSS = `
    .skpdf-root{position:fixed;inset:0;z-index:2100;background:#1b1a2e;display:none;flex-direction:column;color:#e2e0ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}
    .skpdf-root.open{display:flex}
    .skpdf-root *{box-sizing:border-box}
    .skpdf-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;padding-top:calc(8px + env(safe-area-inset-top));background:linear-gradient(90deg,#181330,#2e2261);border-bottom:1px solid rgba(255,255,255,.1);flex-wrap:wrap}
    .skpdf-title{flex:1 1 140px;min-width:0;font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .skpdf-grp{display:flex;align-items:center;gap:4px}
    .skpdf-btn{width:34px;height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s;flex:none}
    .skpdf-btn:hover{background:rgba(10,132,255,.45)}
    .skpdf-btn.on{background:#0a84ff}
    .skpdf-btn:disabled{opacity:.35;cursor:default}
    .skpdf-in{height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;font-size:13px;padding:0 8px;outline:none;text-align:center}
    .skpdf-in:focus{border-color:#0a84ff}
    #skPdfPage{width:46px}
    #skPdfZoomLbl{min-width:46px;text-align:center;font-size:12.5px;font-weight:700}
    .skpdf-sep{width:1px;height:22px;background:rgba(255,255,255,.15);margin:0 4px}
    .skpdf-search{display:none;align-items:center;gap:6px;padding:8px 12px;background:#231f47;border-bottom:1px solid rgba(255,255,255,.08)}
    .skpdf-search.open{display:flex}
    #skPdfQ{flex:1;min-width:0;text-align:left;padding:0 12px}
    #skPdfQCount{font-size:12px;color:rgba(255,255,255,.65);min-width:64px;text-align:center}
    .skpdf-main{flex:1;display:flex;min-height:0;position:relative}
    .skpdf-side{width:150px;flex:none;overflow-y:auto;background:#16142a;border-right:1px solid rgba(255,255,255,.08);padding:10px;display:none}
    .skpdf-side.open{display:block}
    .skpdf-th{display:block;margin:0 auto 12px;cursor:pointer;text-align:center;font-size:11px;color:rgba(255,255,255,.6)}
    .skpdf-th canvas{display:block;margin:0 auto 4px;background:#fff;border-radius:3px;border:2px solid transparent;max-width:100%}
    .skpdf-th.cur canvas{border-color:#0a84ff}
    .skpdf-scroll{flex:1;overflow:auto;padding:16px 0 80px;background:#2a2742;-webkit-overflow-scrolling:touch;position:relative;scroll-behavior:auto}
    .skpdf-root.paper .skpdf-scroll{background:#d9d9de}
    .skpdf-pages{display:flex;flex-direction:column;align-items:center;gap:14px;min-width:min-content}
    .skpdf-page{position:relative;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.45);flex:none;overflow:hidden}
    .skpdf-page canvas{display:block;width:100%;height:100%}
    .skpdf-page .skpdf-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c9c9d6;font-size:28px;font-weight:800;pointer-events:none}
    .skpdf-tl{position:absolute;inset:0;overflow:hidden;line-height:1;opacity:1}
    .skpdf-tl span{position:absolute;color:transparent;white-space:pre;cursor:text;transform-origin:0 0}
    .skpdf-tl span::selection{background:rgba(10,132,255,.35)}
    .skpdf-tl span.hit{background:rgba(255,213,0,.55);border-radius:2px}
    .skpdf-tl span.hit.cur{background:rgba(255,120,0,.7)}
    .skpdf-msg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px;color:#e2e0ff;font-size:14px;background:#1b1a2e;z-index:5}
    .skpdf-spin{width:34px;height:34px;border:3px solid rgba(255,255,255,.2);border-top-color:#0a84ff;border-radius:50%;animation:skpdfspin .8s linear infinite}
    @keyframes skpdfspin{to{transform:rotate(360deg)}}
    .skpdf-link{display:inline-block;background:#4a3aff;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px}
    .skpdf-pill{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:rgba(15,12,27,.82);backdrop-filter:blur(8px);padding:6px 14px;border-radius:20px;font-size:12px;font-weight:700;pointer-events:none;opacity:0;transition:opacity .25s}
    .skpdf-pill.show{opacity:1}
    .skpdf-pages.two{display:grid;grid-template-columns:repeat(2,max-content);justify-content:center;justify-items:center;align-items:start}
    .skpdf-pages.two.cover .skpdf-page:first-child{grid-column:2}
    .skpdf-vmenu{position:absolute;z-index:10;left:12px;top:58px;display:none;flex-direction:column;width:290px;max-width:calc(100% - 24px);padding:6px 0;background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.5);color:#2c2c2c;max-height:calc(100% - 70px);overflow-y:auto}
    .skpdf-vmenu.show{display:flex}
    .skpdf-mi{display:flex;align-items:center;gap:10px;height:44px;padding:0 16px 0 10px;border:0;background:transparent;color:#2c2c2c;font-size:15px;text-align:left;cursor:pointer;width:100%;flex:none;font-family:inherit}
    .skpdf-mi:hover{background:#f0f0f2}
    .skpdf-mi:disabled{color:#9a9a9a;cursor:default;background:transparent}
    .skpdf-mck{width:22px;color:#0b63ce;display:flex;justify-content:center;flex:none}
    .skpdf-mic{display:flex;flex:none;width:26px;justify-content:center}
    .skpdf-msep{height:1px;background:#ddd;margin:6px 0;flex:none}
    .skpdf-readx{position:fixed!important;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:9;display:none!important}
    .skpdf-root.read .skpdf-readx{display:inline-flex!important}
    .skpdf-root.read .skpdf-bar,.skpdf-root.read .skpdf-search{display:none}
    .skpdf-root.read .skpdf-pal,.skpdf-root.read .skpdf-tbbar{display:none!important}
    .skpdf-pal{position:fixed;z-index:8;display:none;flex-direction:column;align-items:center;gap:6px;width:66px;padding:0 8px 10px;background:#fff;border:1px solid #d0d3d9;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.4);color:#202124;user-select:none;-webkit-user-select:none}
    .skpdf-pal.open{display:flex}
    .skpdf-grip{align-self:stretch;margin:0 -8px;height:24px;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;flex:none}
    .skpdf-grip::before{content:'';width:36px;height:6px;border-radius:3px;background:#bdc1c6}
    .skpdf-grip.drag{cursor:grabbing}
    .skpdf-pb,.skpdf-tbb{position:relative;border:0;border-radius:9px;background:transparent;color:#202124;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex:none;font-family:Arial,Helvetica,sans-serif}
    .skpdf-pb{width:48px;height:48px}
    .skpdf-tbb{width:46px;height:44px}
    .skpdf-pb:hover,.skpdf-tbb:hover{background:#eef0f3}
    .skpdf-pb.on{background:#0b63ce;color:#fff}
    .skpdf-pb.fly::after,.skpdf-tbb.fly::after{content:'';position:absolute;right:4px;bottom:5px;width:0;height:0;border-style:solid;border-width:0 0 6px 6px;border-color:transparent transparent currentColor transparent}
    .skpdf-fly{position:fixed;display:none;background:#fff;border:1px solid #d0d3d9;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.4);white-space:nowrap;color:#2c2c2c}
    .skpdf-fly.show{display:block}
    .skpdf-frow{display:flex;align-items:center;gap:8px;padding:8px 10px}
    .skpdf-flist{width:250px;padding:6px 0}
    .skpdf-mckr{margin-left:auto;color:#0b63ce;display:flex;flex:none}
    .skpdf-cg{padding:14px 16px 14px}
    .skpdf-cgt{font-size:16px;margin-bottom:12px;color:#2c2c2c}
    .skpdf-cgg{display:grid;grid-template-columns:repeat(7,40px);gap:8px}
    .skpdf-cs{width:40px;height:40px;border:0;border-radius:3px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
    .skpdf-cs.wh{box-shadow:inset 0 0 0 2px #b5b5b5}
    .skpdf-cs:hover{outline:2px solid #0b63ce;outline-offset:1px}
    .skpdf-cgw{display:flex;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid #e1e3e6}
    .skpdf-colwrap{display:none;flex-direction:column;align-items:center;gap:6px;align-self:stretch}
    .skpdf-colwrap.show{display:flex}
    .skpdf-psep{align-self:stretch;height:1px;background:#d0d3d9;margin:2px 4px}
    .skpdf-chip{display:block;width:30px;height:30px;border-radius:50%;border:2px solid rgba(0,0,0,.22)}
    @media(max-width:700px){.skpdf-cgg{grid-template-columns:repeat(7,32px);gap:6px}.skpdf-cs{width:32px;height:32px}.skpdf-cg{padding:12px}}
    .skpdf-swb{width:26px;height:26px;border-radius:50%;border:2px solid rgba(0,0,0,.18);cursor:pointer;padding:0;flex:none}
    .skpdf-swb.on{border-color:#fff;box-shadow:0 0 0 2px #0b63ce}
    .skpdf-wb{width:30px;height:30px;border-radius:8px;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none}
    .skpdf-wb i{display:block;border-radius:50%;background:#202124}
    .skpdf-wb.on{background:#cfe0f9}
    .skpdf-fb{height:34px;padding:0 12px;border:0;border-radius:8px;background:#eef0f3;color:#202124;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px}
    .skpdf-fb:hover{background:#e0e4ea}
    .skpdf-fsep{width:1px;height:22px;background:#d0d3d9;flex:none}
    .skpdf-tbbar{position:fixed;z-index:9;display:none;align-items:center;gap:2px;padding:6px 8px;background:#fff;border:1px solid #d0d3d9;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.35);color:#202124;user-select:none;-webkit-user-select:none}
    .skpdf-tbbar.show{display:flex}
    .skpdf-tbcol{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);display:none;background:#fff;border:1px solid #d0d3d9;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35)}
    .skpdf-tbcol.show{display:block}
    .skpdf-tbbar.mk [data-a=sp],.skpdf-tbbar.ed [data-a=sp]{display:none}
    .skpdf-tbbar:not(.ed) [data-a=mv]{display:none}
    .skpdf-tbb[data-a=mv]{cursor:grab;touch-action:none}
    .skpdf-tbb[data-a=mv]:active{cursor:grabbing}
    .skpdf-pb.on#skAnnEdit{background:#e8f0fe;color:#1a73e8}
    .skpdf-ann{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;z-index:3}
    .skpdf-hl{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;z-index:2;mix-blend-mode:multiply}
    .skpdf-hlg>div{position:absolute;border-radius:2px}
    .skpdf-ink{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
    .skpdf-mark{position:absolute;pointer-events:none;overflow:visible}
    .skpdf-root.tool-text .skpdf-mark,.skpdf-root.tool-select .skpdf-mark{pointer-events:auto;cursor:move;touch-action:none}
    .skpdf-root .skpdf-mark.sel{outline:1px solid #1a73e8;outline-offset:3px}
    .skpdf-root.tool-erase .skpdf-mark{pointer-events:auto;cursor:pointer}
    .skpdf-root.tool-erase .skpdf-mark:hover{filter:drop-shadow(0 0 3px #ff3b30)}
    .skpdf-tb{position:absolute;white-space:pre;line-height:1.2;font-family:Helvetica,Arial,'Noto Nastaliq Urdu','Noto Naskh Arabic',sans-serif;min-width:8px;min-height:1.2em;padding:2px 4px;margin:-2px 0 0 -4px;outline:none;pointer-events:none;-webkit-user-select:text;user-select:text}
    .skpdf-tb:empty{min-width:7.5em}
    .skpdf-tb:empty::before{content:'Type text here';color:#9aa0a6}
    .skpdf-root.tool-text .skpdf-ann{pointer-events:auto;cursor:text}
    .skpdf-root.tool-draw .skpdf-ann{pointer-events:auto;cursor:crosshair;touch-action:none;user-select:none;-webkit-user-select:none}
    .skpdf-root.tool-text .skpdf-tb,.skpdf-root.tool-select .skpdf-tb{pointer-events:auto;cursor:text;touch-action:none}
    .skpdf-root.tool-text .skpdf-tb:hover,.skpdf-root.tool-select .skpdf-tb:hover{outline:1px solid rgba(26,115,232,.55);outline-offset:1px}
    .skpdf-root .skpdf-tb.sel,.skpdf-root .skpdf-tb:focus{outline:1px solid #1a73e8;outline-offset:1px}
    .skpdf-root.tool-erase .skpdf-hlg>div,.skpdf-root.tool-erase .skpdf-tb{pointer-events:auto;cursor:pointer}
    .skpdf-root.tool-erase .skpdf-hlg>div:hover,.skpdf-root.tool-erase .skpdf-tb:hover{outline:2px solid #ff3b30}
    .skpdf-root.tool-erase .skpdf-ink .hit{pointer-events:stroke;cursor:pointer}
    .skpdf-root.tool-erase .skpdf-ink:hover{filter:drop-shadow(0 0 3px #ff3b30)}
    .skpdf-root.tool-hl .skpdf-tl span{cursor:text}
    .skpdf-hlbtn{position:fixed;z-index:6;display:none;transform:translateX(-50%);background:#0a84ff;color:#fff;border:0;border-radius:20px;padding:9px 18px;font-size:13px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.45)}
    .skpdf-sidehead{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;position:sticky;top:-10px;z-index:2;background:#16142a;padding:0 0 6px}
    .skpdf-sidebtn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:8px 6px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#fff;font-size:12px;font-weight:700;cursor:pointer}
    .skpdf-sidebtn:hover{background:rgba(10,132,255,.45)}
    .skpdf-sidebtn.on{background:#0a84ff;border-color:#0a84ff}
    .skpdf-ed{position:absolute;white-space:pre;line-height:1;outline:none;pointer-events:none;box-sizing:content-box;min-height:1em;-webkit-user-select:text;user-select:text;font-variant-ligatures:none;font-kerning:none;text-rendering:optimizeSpeed;font-feature-settings:"liga" 0,"clig" 0,"dlig" 0,"rlig" 0,"calt" 0,"ccmp" 0,"locl" 0,"kern" 0,"mark" 0,"mkmk" 0}
    /* paints over the ORIGINAL line, wherever the edited line has been moved to */
    .skpdf-ed::before{content:'';position:absolute;left:var(--cx,0);top:var(--cy,0);width:var(--cw,0);height:var(--ch,0);background:var(--cb,#fff);z-index:-1;pointer-events:none}
    .skpdf-root.edit-text .skpdf-ed{touch-action:none}
    .skpdf-root .skpdf-ed.sel{box-shadow:0 0 0 2px #0a84ff}
    .skpdf-root.edit-text .skpdf-ed{pointer-events:auto;cursor:text}
    .skpdf-root.edit-text .skpdf-ed:hover{box-shadow:0 0 0 1px rgba(10,132,255,.7)}
    .skpdf-root.edit-text .skpdf-ed:focus{box-shadow:0 0 0 2px #0a84ff}
    .skpdf-root.tool-erase .skpdf-ed{pointer-events:auto;cursor:pointer}
    .skpdf-root.edit-text .skpdf-tl span{cursor:text;-webkit-user-select:none;user-select:none}
    .skpdf-root.edit-text .skpdf-tl span:hover{background:rgba(10,132,255,.16);box-shadow:0 0 0 1px rgba(10,132,255,.6);border-radius:2px}
    .skpdf-root.skpdf-split.pane-a{right:calc(100% - var(--sp,50%))}
    .skpdf-root.skpdf-split.pane-b{left:var(--sp,50%)}
    .skpdf-root.skpdf-split{overflow:hidden}
    .skpdf-root.skpdf-split .skpdf-bar{padding:6px 8px;gap:4px}
    .skpdf-root.skpdf-split .skpdf-title{flex-basis:100%;order:-1}
    .skpdf-root.skpdf-split .skpdf-hide-s{display:none}
    .skpdf-root.skpdf-split .skpdf-side{position:absolute;z-index:4;top:0;bottom:0;left:0;width:120px;box-shadow:4px 0 20px rgba(0,0,0,.5)}
    .skpdf-root.skpdf-split.active .skpdf-bar{box-shadow:inset 0 2px 0 #0a84ff}
    .skpdf-divider{position:fixed;z-index:2105;top:0;bottom:0;left:var(--sp,50%);width:14px;margin-left:-7px;cursor:col-resize;display:none;touch-action:none}
    .skpdf-divider.show{display:block}
    .skpdf-divider::before{content:'';position:absolute;left:6px;top:0;bottom:0;width:2px;background:rgba(255,255,255,.22)}
    .skpdf-divider:hover::before{background:#0a84ff}
    .skpdf-swap{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:44px;height:44px;border-radius:50%;border:2px solid rgba(255,255,255,.18);background:#4a3aff;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.5);padding:0}
    .skpdf-swap:hover{background:#5d4fff;transform:translate(-50%,-50%) scale(1.06)}
    body.skpdf-dragging{user-select:none;-webkit-user-select:none;cursor:col-resize}
    body.skpdf-dragging .skpdf-root iframe,body.skpdf-dragging .skpdf-root canvas{pointer-events:none}
    @media(max-width:700px){
      .skpdf-root.skpdf-split.pane-a{right:0;bottom:calc(100% - var(--sp,50%))}
      .skpdf-root.skpdf-split.pane-b{left:0;top:var(--sp,50%)}
      .skpdf-divider{top:var(--sp,50%);bottom:auto;left:0;right:0;width:auto;height:14px;margin:-7px 0 0 0;cursor:row-resize}
      .skpdf-divider::before{left:0;right:0;top:6px;bottom:auto;width:auto;height:2px}
      .skpdf-swap{width:40px;height:40px}
      .skpdf-swap svg{transform:rotate(90deg)}
    }
    @media(max-width:700px){
      .skpdf-title{flex-basis:100%;order:-1}
      .skpdf-side{position:absolute;z-index:4;top:0;bottom:0;left:0;width:130px;box-shadow:4px 0 20px rgba(0,0,0,.5)}
      .skpdf-hide-m{display:none}
    }`;

    /* ───────────── icons ───────────── */
    const I = (d, s) => `<svg width="${s || 17}" height="${s || 17}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const ICON = {
        close: I('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
        plus: I('<path d="M5 12h14"/><path d="M12 5v14"/>'),
        minus: I('<path d="M5 12h14"/>'),
        fit: I('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'),
        rotate: I('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
        search: I('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
        down: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
        print: I('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
        side: I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'),
        up: I('<path d="m18 15-6-6-6 6"/>'),
        dn: I('<path d="m6 9 6 6 6-6"/>'),
        pen: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
        hl: I('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
        type: I('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'),
        eraser: I('<path d="m7 21-4.3-4.3c-1-1-1-2.6 0-3.5l9.6-9.6c1-1 2.5-1 3.5 0l5.6 5.6c1 1 1 2.5 0 3.5L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
        undo: I('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
        save: I('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
        sun: I('<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>')
    };

    const ICON2 = {
        cursor: I('<path fill="currentColor" d="M5 3l14 7.5-6.2 1.9L10.5 19z"/>', 26),
        hl: I('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>', 26),
        draw: I('<path d="M3 17c3-8 5-10 7-8s0 7 3 7 3-4 6-9"/>', 26),
        textbox: I('<rect x="3" y="3" width="18" height="18" rx="1.5" stroke-dasharray="3 2.4"/><path d="M8 17l4-10 4 10M9.4 13.6h5.2"/>', 26),
        eraser: I('<path d="m7 21-4.3-4.3c-1-1-1-2.6 0-3.5l9.6-9.6c1-1 2.5-1 3.5 0l5.6 5.6c1 1 1 2.5 0 3.5L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>', 26),
        more: I('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>', 26),
        trash: I('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>', 26),
        editText: I('<path d="M3 6V4h13v2M9.5 4v13M7 17h5"/><path d="M14.5 21l.8-3.2 5.6-5.6a1.4 1.4 0 0 1 2 2l-5.6 5.6z"/>', 26),
        move: I('<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>', 26),
        recolor: I('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', 26),
        spacing: I('<text x="12" y="10" text-anchor="middle" font-size="10" font-weight="800" fill="currentColor" stroke="none" font-family="Arial,sans-serif">VA</text><path d="M3 17h18M6 14l-3 3 3 3M18 14l3 3-3 3"/>', 26)
    };

    const ICON3 = {
        view: I('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
        check: I('<polyline points="20 6 9 17 4 12"/>', 18),
        single: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 20),
        two: I('<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>', 20),
        cover: I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M7 8h2M7 12h2M15 8h2"/>', 20),
        scroll: I('<path d="M12 3v18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/>', 20),
        actual: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none" font-family="Arial,sans-serif">1:1</text>', 20),
        page: I('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>', 20),
        width: I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 12h10M7 12l2-2M7 12l2 2M17 12l-2-2M17 12l-2 2"/>', 20),
        height: I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 7v10M12 7l-2 2M12 7l2 2M12 17l-2-2M12 17l2-2"/>', 20),
        content: I('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="8" y="8" width="8" height="8" rx="1"/>', 20),
        read: I('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>', 20),
        full: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>', 20)
    };

    const MARK_ICON = {
        text: ICON2.textbox,
        x: I('<path d="M5 5l14 14M19 5L5 19"/>', 26),
        check: I('<path d="M4 13l5 5L20 6"/>', 26),
        dot: I('<circle cx="12" cy="12" r="4.5" fill="currentColor"/>', 26),
        circle: I('<rect x="3" y="6" width="18" height="12" rx="5"/>', 26)
    };
    const MARK_LABEL = { text: 'Type text', x: 'Crossmark', check: 'Checkmark', dot: 'Dot', circle: 'Circle around' };
    const CHK_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" stroke="rgba(0,0,0,.55)" stroke-width="5"/><polyline points="20 6 9 17 4 12" stroke="#fff" stroke-width="3"/></svg>';

    /* ───────────── state ───────────── */
    let libPromise = null;
    const viewers = [];          // every viewer instance (1 normally, 2 in split view)
    let activeViewer = null;     // the pane that keyboard shortcuts go to
    const prefs = (() => {
        const d = { hl: HL_COLORS[0], tx: '#000000', size: 16, ink: '#d93025', inkW: 4, mark: 'text', markSize: 18 };
        try { return Object.assign(d, JSON.parse(localStorage.getItem(LS_PREFS) || '{}')); } catch (e) { return d; }
    })();

    function loadScript(src, ready) {
        if (ready()) return Promise.resolve();
        loadScript._p = loadScript._p || {};
        if (loadScript._p[src]) return loadScript._p[src];
        loadScript._p[src] = new Promise((resolve, reject) => {
            const sc = document.createElement('script');
            sc.src = src;
            sc.onload = () => resolve();
            sc.onerror = () => { delete loadScript._p[src]; reject(new Error('Could not load a required library (are you offline?).')); };
            document.head.appendChild(sc);
        });
        return loadScript._p[src];
    }
    const loadPdfLib = () => loadScript(PDFLIB_SRC, () => !!window.PDFLib);

    function loadLib() {
        if (window.pdfjsLib) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return Promise.resolve(); }
        if (libPromise) return libPromise;
        libPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = PDFJS_SRC;
            s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; resolve(); };
            s.onerror = () => { libPromise = null; reject(new Error('Could not load the PDF engine (are you offline?).')); };
            document.head.appendChild(s);
        });
        return libPromise;
    }

    function createViewer() {
    let root = null, els = {}, pdf = null, ctx = null; // ctx = current open context
    let ioObs = null, pointerTouch = false, selT = 0;
    let api = null;

    function build() {
        if (root) return;
        if (!document.getElementById('skPdfStyle')) {
            const st = document.createElement('style');
            st.id = 'skPdfStyle';
            st.textContent = CSS;
            document.head.appendChild(st);
        }

        root = document.createElement('div');
        root.className = 'skpdf-root';
        root.innerHTML = `
        <div class="skpdf-bar">
            <button class="skpdf-btn" id="skPdfClose" title="Close (Esc)">${ICON.close}</button>
            <button class="skpdf-btn" id="skPdfViewBtn" title="View options">${ICON3.view}</button>
            <button class="skpdf-btn" id="skPdfSplitBtn" title="Open a second PDF side by side">${ICON_SPLIT}</button>
            <div class="skpdf-title" id="skPdfTitle"></div>
            <div class="skpdf-grp">
                <button class="skpdf-btn" id="skPdfSideBtn" title="Thumbnails">${ICON.side}</button>
                <button class="skpdf-btn" id="skPdfSearchBtn" title="Search (Ctrl+F)">${ICON.search}</button>
                <button class="skpdf-btn" id="skPdfAnnBtn" title="Highlight &amp; write on PDF">${ICON.pen}</button>
                <span class="skpdf-sep skpdf-hide-m"></span>
                <input class="skpdf-in" id="skPdfPage" inputmode="numeric" value="1" title="Page">
                <span id="skPdfTotal" style="font-size:12.5px;opacity:.7;min-width:32px">/ 0</span>
                <span class="skpdf-sep"></span>
                <button class="skpdf-btn" id="skPdfZout" title="Zoom out (-)">${ICON.minus}</button>
                <span id="skPdfZoomLbl">100%</span>
                <button class="skpdf-btn" id="skPdfZin" title="Zoom in (+)">${ICON.plus}</button>
                <button class="skpdf-btn" id="skPdfFit" title="Fit width (0)">${ICON.fit}</button>
                <button class="skpdf-btn skpdf-hide-s" id="skPdfRot" title="Rotate (R)">${ICON.rotate}</button>
                <span class="skpdf-sep skpdf-hide-m"></span>
                <button class="skpdf-btn skpdf-hide-m skpdf-hide-s" id="skPdfMode" title="Toggle paper / dark background">${ICON.sun}</button>
                <button class="skpdf-btn skpdf-hide-s" id="skPdfPrint" title="Print">${ICON.print}</button>
                <button class="skpdf-btn" id="skPdfDl" title="Download">${ICON.down}</button>
            </div>
        </div>
        <div class="skpdf-search" id="skPdfSearch">
            <input class="skpdf-in" id="skPdfQ" placeholder="Search in document…" autocomplete="off">
            <span id="skPdfQCount"></span>
            <button class="skpdf-btn" id="skPdfQPrev" title="Previous (Shift+Enter)">${ICON.up}</button>
            <button class="skpdf-btn" id="skPdfQNext" title="Next (Enter)">${ICON.dn}</button>
        </div>
        <div class="skpdf-main">
            <div class="skpdf-side" id="skPdfSide"><div class="skpdf-sidehead"><button class="skpdf-sidebtn" id="skPdfEditBtn" title="Click any line of text to change it">${ICON_EDIT}<span>Edit text</span></button><button class="skpdf-sidebtn" id="skPdfSaveBtn" title="Save a copy with your edits">${ICON_SAVE}<span>Save PDF</span></button></div><div id="skPdfThumbs"></div></div>
            <div class="skpdf-scroll" id="skPdfScroll"><div class="skpdf-pages" id="skPdfPages"></div></div>
            <div class="skpdf-pill" id="skPdfPill"></div>
            <div class="skpdf-msg" id="skPdfMsg"></div>
        </div>
        <button class="skpdf-hlbtn" id="skPdfHlBtn">Highlight selection</button>
        <div class="skpdf-vmenu" id="skPdfViewMenu"></div>
        <button class="skpdf-btn skpdf-readx" id="skPdfReadX" title="Exit read mode (Esc)">${ICON.close}</button>
        <div class="skpdf-pal" id="skPdfAnnBar">
            <div class="skpdf-grip" id="skAnnGrip" title="Drag to move"></div>
            <button class="skpdf-pb" id="skAnnSel" title="Select / move text">${ICON2.cursor}</button>
            <button class="skpdf-pb fly" id="skAnnHl" title="Highlight text">${ICON2.hl}</button>
            <button class="skpdf-pb fly" id="skAnnDraw" title="Draw">${ICON2.draw}</button>
            <button class="skpdf-pb fly" id="skAnnTx" title="Add text">${ICON2.textbox}</button>
            <button class="skpdf-pb" id="skAnnEdit" title="Edit existing text">${ICON2.editText}</button>
            <button class="skpdf-pb" id="skAnnEr" title="Eraser">${ICON2.eraser}</button>
            <div class="skpdf-colwrap" id="skAnnColWrap"><div class="skpdf-psep"></div><button class="skpdf-pb" id="skAnnCol" title="Colour"><span class="skpdf-chip" id="skAnnChip"></span></button><div class="skpdf-psep"></div></div>
            <button class="skpdf-pb fly" id="skAnnMore" title="More">${ICON2.more}</button>
            <div class="skpdf-fly" id="skAnnFly"></div>
        </div>
        <div class="skpdf-tbbar" id="skTbBar">
            <button class="skpdf-tbb" data-a="mv" title="Drag to move">${ICON2.move}</button>
            <button class="skpdf-tbb" data-a="sm" title="Smaller text"><span style="font-size:14px;font-weight:700">A</span></button>
            <button class="skpdf-tbb" data-a="lg" title="Larger text"><span style="font-size:25px">A</span></button>
            <button class="skpdf-tbb" data-a="del" title="Delete">${ICON2.trash}</button>
            <button class="skpdf-tbb fly" id="skTbColBtn" data-a="col" title="Text colour">${ICON2.recolor}</button>
            <button class="skpdf-tbb" data-a="sp" title="Letter spacing">${ICON2.spacing}</button>
            <div class="skpdf-tbcol" id="skTbCol"></div>
        </div>`;
        document.body.appendChild(root);

        const q = (id) => root.querySelector('#' + id);
        els = {
            title: q('skPdfTitle'), page: q('skPdfPage'), total: q('skPdfTotal'), zoom: q('skPdfZoomLbl'),
            scroll: q('skPdfScroll'), pages: q('skPdfPages'), side: q('skPdfSide'), msg: q('skPdfMsg'),
            pill: q('skPdfPill'), search: q('skPdfSearch'), q: q('skPdfQ'), qCount: q('skPdfQCount'),
            sideBtn: q('skPdfSideBtn'), searchBtn: q('skPdfSearchBtn'),
            annBtn: q('skPdfAnnBtn'), annbar: q('skPdfAnnBar'), annFly: q('skAnnFly'), grip: q('skAnnGrip'),
            hlBtn: q('skPdfHlBtn'), tbBar: q('skTbBar'), tbCol: q('skTbCol'), tbColBtn: q('skTbColBtn'),
            viewBtn: q('skPdfViewBtn'), viewMenu: q('skPdfViewMenu'), thumbs: q('skPdfThumbs'), editBtn: q('skPdfEditBtn'), saveBtn: q('skPdfSaveBtn'),
            tCol: q('skAnnCol'), colWrap: q('skAnnColWrap'), chip: q('skAnnChip'),
            tSel: q('skAnnSel'), tHl: q('skAnnHl'), tDraw: q('skAnnDraw'), tTx: q('skAnnTx'), tEd: q('skAnnEdit'), tEr: q('skAnnEr'), tMore: q('skAnnMore')
        };

        q('skPdfClose').onclick = () => close();
        q('skPdfSplitBtn').onclick = () => Split.pick(api);
        root.addEventListener('pointerdown', () => { activeViewer = api; Split.markActive(); }, true);
        root.addEventListener('focusin', () => { activeViewer = api; Split.markActive(); });
        q('skPdfZin').onclick = () => zoomBy(1.2);
        q('skPdfZout').onclick = () => zoomBy(1 / 1.2);
        q('skPdfFit').onclick = fitWidth;
        q('skPdfRot').onclick = rotate;
        q('skPdfDl').onclick = download;
        q('skPdfPrint').onclick = printDoc;
        q('skPdfMode').onclick = () => {
            root.classList.toggle('paper');
            try { localStorage.setItem(LS_MODE, root.classList.contains('paper') ? 'paper' : 'dark'); } catch (e) {}
        };
        els.sideBtn.onclick = toggleSide;
        els.editBtn.onclick = () => toggleEditText();
        els.saveBtn.onclick = () => exportPdf();
        els.pages.addEventListener('click', onEditClick);
        els.pages.addEventListener('pointerdown', onEditDown);
        els.searchBtn.onclick = toggleSearch;
        els.annBtn.onclick = () => toggleAnn();
        els.viewBtn.onclick = toggleViewMenu;
        els.viewMenu.addEventListener('click', onViewMenuClick);
        q('skPdfReadX').onclick = () => toggleRead(false);
        document.addEventListener('pointerdown', (e) => {
            if (els.viewMenu.classList.contains('show') && !els.viewMenu.contains(e.target) && !els.viewBtn.contains(e.target)) hideViewMenu();
        }, true);
        document.addEventListener('fullscreenchange', () => setTimeout(refit, 150));
        // "Enable scrolling" off: flip pages with the wheel at the edges, or with a swipe
        let flipT = 0;
        els.scroll.addEventListener('wheel', (e) => {
            if (!ctx || ctx.view.scroll || e.ctrlKey || e.metaKey) return;
            const sc = els.scroll, now = Date.now();
            if (now - flipT < 450) return;
            if (e.deltaY > 10 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) { flipT = now; stepPage(1); }
            else if (e.deltaY < -10 && sc.scrollTop <= 0) { flipT = now; stepPage(-1); }
        }, { passive: true });
        let sw0 = null;
        els.scroll.addEventListener('touchstart', (e) => { sw0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
        els.scroll.addEventListener('touchend', (e) => {
            if (!sw0 || !ctx || ctx.view.scroll || ctx.tool === 'draw') { sw0 = null; return; }
            const t = e.changedTouches[0], dx = t.clientX - sw0.x, dy = t.clientY - sw0.y; sw0 = null;
            if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2 && els.scroll.scrollWidth <= els.scroll.clientWidth + 4) stepPage(dx < 0 ? 1 : -1);
        }, { passive: true });
        els.tSel.onclick = () => onToolBtn('select', els.tSel);
        els.tHl.onclick = () => onToolBtn('hl', els.tHl);
        els.tDraw.onclick = () => onToolBtn('draw', els.tDraw);
        els.tTx.onclick = () => onToolBtn('text', els.tTx);
        els.tEr.onclick = () => onToolBtn('erase', els.tEr);
        els.tEd.onclick = () => togglePalEdit();
        els.tMore.onclick = () => toggleFly('more', els.tMore);
        els.tCol.onclick = () => toggleFly('color', els.tCol);
        updateTextIcon();
        els.annFly.addEventListener('click', onFlyClick);
        // keep focus/selection where it is while using the annotation palette / text bar
        els.annbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
        els.tbBar.addEventListener('mousedown', (e) => e.preventDefault());
        els.tbBar.addEventListener('click', onTbBarClick);
        // grab handle on the floating bar: drag the selected edited line (works while it's being typed in)
        els.tbBar.addEventListener('pointerdown', (e) => {
            const b = e.target.closest && e.target.closest('[data-a="mv"]'), s = ctx && ctx.selTb;
            if (!b || !s || s.a.type !== 'edit' || e.button > 0) return;
            e.preventDefault(); dragEd(e, s.el, s.a, b, false);
        });
        initPalette();
        document.addEventListener('pointerdown', (e) => {
            if (!ctx || !ctx.selTb) return;
            if (e.target.closest && (e.target.closest('.skpdf-tb') || e.target.closest('.skpdf-ed') || e.target.closest('.skpdf-mark') || els.tbBar.contains(e.target))) return;
            hideTbBar();
        }, true);
        els.scroll.addEventListener('scroll', () => { if (ctx && ctx.selTb) placeTbBar(); }, { passive: true });
        window.addEventListener('resize', () => { if (ctx && ctx.selTb) placeTbBar(); });
        els.hlBtn.addEventListener('pointerdown', (e) => e.preventDefault());
        els.hlBtn.addEventListener('click', () => { captureHighlight(); els.hlBtn.style.display = 'none'; });
        els.scroll.addEventListener('pointerdown', (e) => { pointerTouch = e.pointerType === 'touch'; }, true);
        els.scroll.addEventListener('mouseup', () => {
            if (ctx && ctx.tool === 'hl' && !pointerTouch) setTimeout(captureHighlight, 0);
        });
        document.addEventListener('selectionchange', () => {
            if (!ctx || ctx.tool !== 'hl' || !pointerTouch) return;
            clearTimeout(selT); selT = setTimeout(updateHlBtn, 250);
        });
        q('skPdfQNext').onclick = () => stepHit(1);
        q('skPdfQPrev').onclick = () => stepHit(-1);

        els.page.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { goToPage(parseInt(els.page.value, 10)); els.page.blur(); }
            e.stopPropagation();
        });
        els.page.addEventListener('focus', () => els.page.select());

        let qTimer;
        els.q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => runSearch(els.q.value.trim()), 280); });
        els.q.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1);
            if (e.key === 'Escape') toggleSearch();
        });

        els.scroll.addEventListener('scroll', onScroll, { passive: true });
        els.scroll.addEventListener('wheel', (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });

        // pinch-to-zoom (commit on release so rendering stays crisp)
        let pinch = null;
        els.scroll.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) pinch = { d: dist(e.touches), ratio: 1 };
        }, { passive: true });
        els.scroll.addEventListener('touchmove', (e) => {
            if (pinch && e.touches.length === 2) {
                e.preventDefault();
                pinch.ratio = dist(e.touches) / pinch.d;
                els.pages.style.transform = `scale(${pinch.ratio})`;
                els.pages.style.transformOrigin = 'top center';
            }
        }, { passive: false });
        els.scroll.addEventListener('touchend', () => {
            if (pinch) {
                const r = pinch.ratio; pinch = null;
                els.pages.style.transform = '';
                if (Math.abs(r - 1) > 0.03) zoomBy(r);
            }
        });

        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', () => { if (ctx) refit(); });
    }

    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    function showMsg(html) { els.msg.style.display = 'flex'; els.msg.innerHTML = html; }
    function hideMsg() { els.msg.style.display = 'none'; }
    function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function pill(text, ms) {
        els.pill.textContent = text; els.pill.classList.add('show');
        clearTimeout(pill._t); pill._t = setTimeout(() => els.pill.classList.remove('show'), ms || 900);
    }

    /* ───────────── open / close ───────────── */
    async function open(opts) {
        build();
        close(true);
        try { if (localStorage.getItem(LS_MODE) === 'paper') root.classList.add('paper'); } catch (e) {}
        ctx = {
            id: opts.id || opts.url, name: opts.name || 'document.pdf', url: opts.url,
            downloadUrl: opts.downloadUrl || opts.url,
            scale: 1, rotation: 0, fitMode: true, sizes: [], pageEls: [], rendered: new Map(),
            current: 1, hits: [], hitIdx: -1, query: '', textCache: new Map(), token: 0, thumbsBuilt: false,
            ann: loadAnn(opts.id || opts.url), undo: [], tool: null, selTb: null, fly: null, view: loadView(), zoomKind: null, fitKind: 'width', text: {}, fontObjs: {}, editText: false
        };
        const my = ctx;
        root.classList.remove(...TOOL_CLASSES, 'read', 'edit-text');
        els.editBtn.classList.remove('on'); els.editBtn.querySelector('span').textContent = 'Edit text'; if (els.tEd) els.tEd.classList.remove('on');
        hideViewMenu();
        hideTbBar(); els.annFly.classList.remove('show');
        els.annbar.classList.remove('open'); els.annBtn.classList.remove('on');
        els.hlBtn.style.display = 'none';
        els.title.textContent = ctx.name;
        els.title.title = ctx.name;
        els.pages.innerHTML = '';
        els.thumbs.innerHTML = '';
        els.side.classList.remove('open');
        els.search.classList.remove('open');
        els.q.value = ''; els.qCount.textContent = '';
        root.classList.add('open');
        activeViewer = api;
        document.body.style.overflow = 'hidden';
        showMsg('<div class="skpdf-spin"></div><div>Opening PDF…</div>');

        try {
            await loadLib();
            const task = window.pdfjsLib.getDocument({ url: ctx.url, withCredentials: false, fontExtraProperties: true });
            const loaded = await task.promise;
            if (ctx !== my) { try { loaded.destroy(); } catch (e) {} return; }
            pdf = loaded;
        } catch (err) {
            if (ctx !== my) return;
            const bad = err && err.name === 'PasswordException';
            showMsg(`<div style="font-size:15px;font-weight:700">${bad ? 'This PDF is password-protected.' : 'Could not open this PDF.'}</div>
                <div style="opacity:.7;max-width:380px">${esc(bad ? 'Download it to open in a PDF app that supports passwords.' : (err && err.message) || 'Unknown error')}</div>
                <a class="skpdf-link" href="${esc(ctx.downloadUrl)}" target="_blank">Download instead</a>`);
            return;
        }

        const n = pdf.numPages;
        els.total.textContent = '/ ' + n;
        // collect page sizes up front so scrollbars & jumping are accurate
        for (let i = 1; i <= n; i++) {
            const p = await pdf.getPage(i);
            if (ctx !== my || !pdf) return;
            const v = p.getViewport({ scale: 1 });
            ctx.sizes.push({ w: v.width, h: v.height });
        }
        hideMsg();
        buildPlaceholders();
        applyView();
        fitWidth(true);

        let start = 1;
        try { start = parseInt(localStorage.getItem(LS_PAGE + ctx.id), 10) || 1; } catch (e) {}
        if (start > 1 && start <= n) { goToPage(start, true); pill('Resumed on page ' + start); }
        if (annCount()) pill('Your annotations were restored', 1500);
        updatePageUI();
    }

    function close(silent) {
        if (!root) return;
        if (ctx) { saveLast(); saveAnnNow(); }
        clearTimeout(saveAnn._t);
        if (els.hlBtn) els.hlBtn.style.display = 'none';
        if (els.tbBar) els.tbBar.classList.remove('show');
        if (els.viewMenu) els.viewMenu.classList.remove('show');
        root.classList.remove('read');
        try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
        if (ioObs) { ioObs.disconnect(); ioObs = null; }
        if (pdf) { try { pdf.destroy(); } catch (e) {} pdf = null; }
        ctx = null;
        root.classList.remove('open');
        els.pages.innerHTML = '';
        els.thumbs.innerHTML = '';
        if (!silent) {
            if (!viewers.some(v => v !== api && v.isOpen())) document.body.style.overflow = '';
            if (activeViewer === api) activeViewer = viewers.find(v => v !== api && v.isOpen()) || null;
            Split.onClosed(api);
        }
    }

    function saveLast() {
        try { localStorage.setItem(LS_PAGE + ctx.id, String(ctx.current)); } catch (e) {}
    }

    /* ───────────── layout & rendering ───────────── */
    function pageDims(i) {
        const s = ctx.sizes[i];
        const swap = ctx.rotation % 180 !== 0;
        const w = (swap ? s.h : s.w) * ctx.scale, h = (swap ? s.w : s.h) * ctx.scale;
        return { w, h };
    }

    function buildPlaceholders() {
        els.pages.innerHTML = '';
        ctx.pageEls = []; ctx.rendered.clear();
        if (ioObs) ioObs.disconnect();
        ioObs = new IntersectionObserver((entries) => {
            entries.forEach(en => {
                const idx = +en.target.dataset.idx;
                if (en.isIntersecting) renderPage(idx);
                else if (ctx && ctx.rendered.has(idx) && Math.abs(idx - ctx.current + 1) > 6) unrenderPage(idx);
            });
        }, { root: els.scroll, rootMargin: '900px 0px' });

        const frag = document.createDocumentFragment();
        for (let i = 0; i < ctx.sizes.length; i++) {
            const d = pageDims(i);
            const el = document.createElement('div');
            el.className = 'skpdf-page';
            el.dataset.idx = i;
            el.style.width = d.w + 'px';
            el.style.height = d.h + 'px';
            el.innerHTML = `<div class="skpdf-num">${i + 1}</div>`;
            frag.appendChild(el);
            ctx.pageEls.push(el);
        }
        els.pages.appendChild(frag);
        ctx.pageEls.forEach(el => ioObs.observe(el));
    }

    function applyZoomLayout() {
        els.zoom.textContent = Math.round(ctx.scale * 100) + '%';
        ctx.token++;
        ctx.rendered.clear();
        ctx.pageEls.forEach((el, i) => {
            const d = pageDims(i);
            el.style.width = d.w + 'px';
            el.style.height = d.h + 'px';
            el.innerHTML = `<div class="skpdf-num">${i + 1}</div>`;
        });
        // re-trigger observer callbacks for visible pages
        ctx.pageEls.forEach(el => { ioObs.unobserve(el); ioObs.observe(el); });
    }

    async function renderPage(idx) {
        if (!ctx || ctx.rendered.has(idx)) return;
        const token = ctx.token, c = ctx;
        c.rendered.set(idx, 'pending');
        try {
            const page = await pdf.getPage(idx + 1);
            if (!ctx || token !== c.token) return;
            const viewport = page.getViewport({ scale: c.scale, rotation: c.rotation });
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            let ratio = dpr;
            // keep canvas under ~16M px so mobile browsers don't choke
            const area = viewport.width * viewport.height * ratio * ratio;
            if (area > 16e6) ratio = Math.sqrt(16e6 / (viewport.width * viewport.height));

            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width * ratio);
            canvas.height = Math.floor(viewport.height * ratio);
            const g = canvas.getContext('2d');
            await page.render({
                canvasContext: g, viewport,
                transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null
            }).promise;
            if (!ctx || token !== c.token) return;

            const el = c.pageEls[idx];
            el.innerHTML = '';
            el.appendChild(canvas);

            // text layer (selectable text + search highlights)
            const tl = document.createElement('div');
            tl.className = 'skpdf-tl';
            tl.style.setProperty('--scale-factor', viewport.scale);
            el.appendChild(tl);
            buildAnnLayer(idx);
            const content = await page.getTextContent();
            if (!ctx || token !== c.token) return;
            window.pdfjsLib.renderTextLayer({ textContentSource: content, container: tl, viewport, textDivs: [] });
            c.text[idx] = { items: content.items, styles: content.styles, page };
            c.rendered.set(idx, tl);
            if (c.query) highlightPage(idx);
        } catch (err) {
            if (c.rendered.get(idx) === 'pending') c.rendered.delete(idx);
        }
    }

    function unrenderPage(idx) {
        const el = ctx.pageEls[idx];
        if (!el) return;
        ctx.rendered.delete(idx);
        el.innerHTML = `<div class="skpdf-num">${idx + 1}</div>`;
    }

    /* ───────────── zoom / rotate / navigation ───────────── */
    function keepPosition(fn) {
        const sc = els.scroll;
        const el = ctx.pageEls[ctx.current - 1];
        const frac = el ? (sc.scrollTop - el.offsetTop) / Math.max(1, el.offsetHeight) : 0;
        fn();
        const el2 = ctx.pageEls[ctx.current - 1];
        if (el2) sc.scrollTop = el2.offsetTop + frac * el2.offsetHeight;
    }

    function setScale(s) {
        if (!ctx) return;
        s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
        if (Math.abs(s - ctx.scale) < 0.001) return;
        keepPosition(() => { ctx.scale = s; ctx.zoomKind = null; applyZoomLayout(); });
    }
    function zoomBy(f) { if (!ctx) return; ctx.fitMode = false; setScale(ctx.scale * f); pill(Math.round(ctx.scale * 100) + '%'); }
    function fitWidth(quiet) {
        if (!ctx || !ctx.sizes.length) return;
        ctx.fitMode = true; ctx.fitKind = 'width';
        const swap = ctx.rotation % 180 !== 0;
        const cols = ctx.view.mode === 'two' ? 2 : 1;
        const w0 = (swap ? ctx.sizes[0].h : ctx.sizes[0].w) * cols;
        // cap so pages don't balloon on very wide desktop screens
        const avail = Math.min(els.scroll.clientWidth - (window.innerWidth < 700 ? 16 : 40), 1000 * cols) - (cols - 1) * 14;
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, avail / w0));
        if (Math.abs(s - ctx.scale) < 0.001) { els.zoom.textContent = Math.round(ctx.scale * 100) + '%'; ctx.zoomKind = 'width'; return; }
        setScale(s);
        ctx.zoomKind = 'width';
        if (quiet !== true) pill('Fit width');
    }
    function rotate() {
        if (!ctx) return;
        keepPosition(() => { ctx.rotation = (ctx.rotation + 90) % 360; if (ctx.fitMode) { const w0 = ctx.rotation % 180 ? ctx.sizes[0].h : ctx.sizes[0].w; ctx.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (els.scroll.clientWidth - 40) / w0)); } applyZoomLayout(); });
        ctx.thumbsBuilt = false;
        if (els.side.classList.contains('open')) buildThumbs();
    }

    function goToPage(n, instant) {
        if (!ctx) return;
        n = Math.min(ctx.sizes.length, Math.max(1, n || 1));
        const el = ctx.pageEls[n - 1];
        if (!el) return;
        if (!ctx.view.scroll) { ctx.current = n; layoutVisible(); updatePageUI(); return; }
        els.scroll.scrollTop = el.offsetTop - 8;
        ctx.current = n;
        updatePageUI();
    }

    let scrollRaf = 0;
    function onScroll() {
        if (scrollRaf || !ctx) return;
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = 0;
            if (!ctx || !ctx.view.scroll) return;
            const mid = els.scroll.scrollTop + els.scroll.clientHeight * 0.35;
            let lo = 0, hi = ctx.pageEls.length - 1, found = 0;
            while (lo <= hi) {
                const m = (lo + hi) >> 1, el = ctx.pageEls[m];
                if (el.offsetTop <= mid) { found = m; lo = m + 1; } else hi = m - 1;
            }
            while (found > 0 && ctx.pageEls[found - 1].offsetTop === ctx.pageEls[found].offsetTop) found--;
            if (found + 1 !== ctx.current) { ctx.current = found + 1; updatePageUI(); }
        });
    }

    function updatePageUI() {
        if (!ctx) return;
        if (document.activeElement !== els.page) els.page.value = ctx.current;
        if (ctx.thumbsBuilt) {
            els.side.querySelectorAll('.skpdf-th').forEach(t => t.classList.toggle('cur', +t.dataset.p === ctx.current));
        }
        clearTimeout(updatePageUI._t);
        updatePageUI._t = setTimeout(() => { if (ctx) saveLast(); }, 500);
    }

    /* ───────────── thumbnails ───────────── */
    function toggleSide() {
        els.side.classList.toggle('open');
        els.sideBtn.classList.toggle('on', els.side.classList.contains('open'));
        if (els.side.classList.contains('open') && ctx && !ctx.thumbsBuilt) buildThumbs();
    }

    async function buildThumbs() {
        if (!ctx || !pdf) return;
        ctx.thumbsBuilt = true;
        els.thumbs.innerHTML = '';
        const c = ctx;
        const holders = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const d = document.createElement('div');
            d.className = 'skpdf-th' + (i === c.current ? ' cur' : '');
            d.dataset.p = i;
            d.innerHTML = `<canvas width="110" height="${Math.round(110 * (c.sizes[i - 1].h / c.sizes[i - 1].w))}"></canvas>${i}`;
            d.onclick = () => goToPage(i);
            els.thumbs.appendChild(d);
            holders.push(d);
        }
        const obs = new IntersectionObserver(async (entries) => {
            for (const en of entries) {
                if (!en.isIntersecting) continue;
                obs.unobserve(en.target);
                const p = +en.target.dataset.p;
                try {
                    const page = await pdf.getPage(p);
                    const cv = en.target.querySelector('canvas');
                    const vp0 = page.getViewport({ scale: 1, rotation: c.rotation });
                    const vp = page.getViewport({ scale: 110 / vp0.width, rotation: c.rotation });
                    cv.width = vp.width; cv.height = vp.height;
                    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
                } catch (e) {}
            }
        }, { root: els.side, rootMargin: '200px' });
        holders.forEach(h => obs.observe(h));
    }

    /* ───────────── search ───────────── */
    function toggleSearch() {
        const open = els.search.classList.toggle('open');
        els.searchBtn.classList.toggle('on', open);
        if (open) { els.q.focus(); els.q.select(); }
        else { els.q.value = ''; runSearch(''); }
    }

    async function pageText(i) {
        if (ctx.textCache.has(i)) return ctx.textCache.get(i);
        const page = await pdf.getPage(i + 1);
        const tc = await page.getTextContent();
        const items = tc.items.map(it => it.str || '');
        ctx.textCache.set(i, items);
        return items;
    }

    async function runSearch(query) {
        if (!ctx) return;
        const c = ctx;
        c.query = query.toLowerCase(); c.hits = []; c.hitIdx = -1;
        ctx.rendered.forEach((tl, idx) => { if (tl && tl.nodeType) clearHighlight(tl); });
        if (!query) { els.qCount.textContent = ''; return; }
        els.qCount.textContent = 'Searching…';
        const needle = c.query;
        for (let i = 0; i < pdf.numPages; i++) {
            if (ctx !== c || c.query !== needle) return; // superseded
            const items = await pageText(i);
            items.forEach((s, k) => {
                if (s.toLowerCase().includes(needle)) c.hits.push({ page: i, item: k });
            });
            els.qCount.textContent = c.hits.length ? `${c.hits.length}+ found` : 'Searching…';
        }
        if (ctx !== c || c.query !== needle) return;
        els.qCount.textContent = c.hits.length ? `${c.hits.length} found` : 'No results';
        c.rendered.forEach((tl, idx) => { if (tl && tl.nodeType) highlightPage(idx); });
        if (c.hits.length) stepHit(1);
    }

    function clearHighlight(tl) { tl.querySelectorAll('span.hit').forEach(s => s.classList.remove('hit', 'cur')); }

    function highlightPage(idx) {
        const tl = ctx.rendered.get(idx);
        if (!tl || !tl.nodeType || !ctx.query) return;
        const spans = tl.querySelectorAll('span');
        spans.forEach(s => { if ((s.textContent || '').toLowerCase().includes(ctx.query)) s.classList.add('hit'); });
        markCurrent();
    }

    function markCurrent() {
        if (!ctx || ctx.hitIdx < 0) return;
        els.pages.querySelectorAll('span.hit.cur').forEach(s => s.classList.remove('cur'));
        const h = ctx.hits[ctx.hitIdx];
        const tl = ctx.rendered.get(h.page);
        if (!tl || !tl.nodeType) return;
        // Nth matching span on this page = ordinal among hits on the same page
        const ord = ctx.hits.slice(0, ctx.hitIdx).filter(x => x.page === h.page).length;
        const hits = tl.querySelectorAll('span.hit');
        const target = hits[ord] || hits[0];
        if (target) {
            target.classList.add('cur');
            const r = target.getBoundingClientRect(), sr = els.scroll.getBoundingClientRect();
            if (r.top < sr.top + 60 || r.bottom > sr.bottom - 60) els.scroll.scrollTop += r.top - sr.top - sr.height / 3;
        }
    }

    function stepHit(dir) {
        if (!ctx || !ctx.hits.length) return;
        ctx.hitIdx = (ctx.hitIdx + dir + ctx.hits.length) % ctx.hits.length;
        const h = ctx.hits[ctx.hitIdx];
        els.qCount.textContent = `${ctx.hitIdx + 1} / ${ctx.hits.length}`;
        goToPage(h.page + 1);
        // wait for the page to render, then mark
        let tries = 0;
        const wait = setInterval(() => {
            tries++;
            const tl = ctx && ctx.rendered.get(h.page);
            if (tl && tl.nodeType) { clearInterval(wait); highlightPage(h.page); markCurrent(); }
            else if (tries > 30) clearInterval(wait);
        }, 100);
    }


    /* ───────────── annotations: highlight / text / eraser ───────────── */
    // Annotations live in "base" page units (PDF points, unrotated, origin
    // top-left) so they survive zoom and rotation and map 1:1 onto the PDF.
    const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    function loadAnn(id) {
        try {
            const raw = localStorage.getItem(LS_ANN + id);
            const o = raw && JSON.parse(raw);
            return (o && o.pages) || {};
        } catch (e) { return {}; }
    }
    function annCount() {
        let n = 0;
        if (ctx) Object.keys(ctx.ann).forEach(k => ctx.ann[k].forEach(a => { if (a.type !== 'text' || (a.text && a.text.trim())) n++; }));
        return n;
    }
    function saveAnnNow() {
        if (!ctx) return;
        clearTimeout(saveAnn._t);
        try {
            const pages = {};
            Object.keys(ctx.ann).forEach(k => {
                const list = ctx.ann[k].filter(a => a.type !== 'text' || (a.text && a.text.trim()));
                if (list.length) pages[k] = list;
            });
            if (Object.keys(pages).length) localStorage.setItem(LS_ANN + ctx.id, JSON.stringify({ v: 1, pages }, (k, v) => (k[0] === '_' ? undefined : v)));
            else localStorage.removeItem(LS_ANN + ctx.id);
        } catch (e) {}
    }
    function saveAnn() { clearTimeout(saveAnn._t); saveAnn._t = setTimeout(saveAnnNow, 400); }
    function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify(prefs)); } catch (e) {} }

    // base (x,y) -> CSS transform that lays the base-unit layer over the rotated, scaled page
    function layerTransform(w0, h0, s, r) {
        if (r === 90) return `translate(${h0 * s}px,0) rotate(90deg) scale(${s})`;
        if (r === 180) return `translate(${w0 * s}px,${h0 * s}px) rotate(180deg) scale(${s})`;
        if (r === 270) return `translate(0,${w0 * s}px) rotate(270deg) scale(${s})`;
        return `scale(${s})`;
    }
    function clientToBase(idx, cx, cy) {
        const rect = ctx.pageEls[idx].getBoundingClientRect(), z = ctx.scale, sz = ctx.sizes[idx];
        const u = (cx - rect.left) / z, v = (cy - rect.top) / z;
        switch (ctx.rotation) {
            case 90: return { x: v, y: sz.h - u };
            case 180: return { x: sz.w - u, y: sz.h - v };
            case 270: return { x: sz.w - v, y: u };
            default: return { x: u, y: v };
        }
    }

    const TOOL_CLASSES = ['tool-select', 'tool-hl', 'tool-draw', 'tool-text', 'tool-erase'];
    const NS_SVG = 'http://www.w3.org/2000/svg';
    const FLY_TOOLS = { hl: 1, draw: 1, text: 1 };
    const HINTS = {
        select: 'Click a text box to edit it, drag to move it',
        hl: 'Select text to highlight it',
        draw: 'Draw on the page',
        text: 'Tap the page, then type',
        erase: 'Tap a highlight, drawing or text to remove it'
    };

    function inkPath(p) {
        const f = (n) => (Math.round(n * 100) / 100);
        if (p.length < 2) return 'M' + f(p[0].x) + ' ' + f(p[0].y) + 'L' + f(p[0].x) + ' ' + f(p[0].y);
        let d = 'M' + f(p[0].x) + ' ' + f(p[0].y);
        for (let i = 1; i < p.length - 1; i++) {
            const mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2;
            d += 'Q' + f(p[i].x) + ' ' + f(p[i].y) + ' ' + f(mx) + ' ' + f(my);
        }
        const l = p[p.length - 1];
        return d + 'L' + f(l.x) + ' ' + f(l.y);
    }

    function buildAnnLayer(idx) {
        if (!ctx) return;
        const el = ctx.pageEls[idx]; if (!el) return;
        if (ctx.selTb && el.contains(ctx.selTb.el)) hideTbBar();
        el.querySelectorAll('.skpdf-ann,.skpdf-hl').forEach(n => n.remove());
        const sz = ctx.sizes[idx];
        const mk = (cls) => {
            const d = document.createElement('div');
            d.className = cls; d.dataset.idx = idx;
            d.style.width = sz.w + 'px'; d.style.height = sz.h + 'px';
            d.style.transform = layerTransform(sz.w, sz.h, ctx.scale, ctx.rotation);
            return d;
        };
        // highlights live in their own layer that multiplies with the page (like a real marker),
        // text boxes and drawings sit above it in the normal layer
        const H = mk('skpdf-hl'), L = mk('skpdf-ann');
        (ctx.ann[idx] || []).forEach(a => (a.type === 'hl' ? H : L).appendChild(makeAnnEl(a)));
        L.addEventListener('pointerdown', (e) => onLayerDown(e, L, idx), true);
        L.addEventListener('click', (e) => onLayerClick(e, L, idx));
        H.addEventListener('click', (e) => onLayerClick(e, H, idx));
        el.appendChild(H);
        el.appendChild(L);
    }

    function markSvg(a) {
        const w = a.w, h = a.h, c = a.color;
        const sw = a.kind === 'circle' ? 2 : Math.max(1.5, Math.min(w, h) * 0.12);
        const st = `fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`;
        if (a.kind === 'x') return `<path d="M${w * .1} ${h * .1}L${w * .9} ${h * .9}M${w * .9} ${h * .1}L${w * .1} ${h * .9}" ${st}/>`;
        if (a.kind === 'check') return `<path d="M${w * .1} ${h * .55}L${w * .38} ${h * .85}L${w * .92} ${h * .15}" ${st}/>`;
        if (a.kind === 'dot') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${c}"/>`;
        return `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(1, w - sw)}" height="${Math.max(1, h - sw)}" rx="${Math.min(w, h) / 2.6}" ${st}/>`;
    }
    function updateMarkEl(s, a) {
        s.style.left = a.x + 'px'; s.style.top = a.y + 'px';
        s.setAttribute('width', a.w); s.setAttribute('height', a.h); s.setAttribute('viewBox', `0 0 ${a.w} ${a.h}`);
        s.innerHTML = markSvg(a);
    }
    function applyTbStyle(d, a) {
        if (a.type === 'edit') { edLayout(d, a); if (ctx && ctx.selTb && ctx.selTb.el === d) els.tbColBtn.style.color = a.color; return; }
        if (a.type === 'mark') { updateMarkEl(d, a); if (ctx && ctx.selTb && ctx.selTb.el === d) els.tbColBtn.style.color = a.color; return; }
        d.style.fontSize = a.size + 'px';
        d.style.color = a.color;
        const sp = a.sp || 0;
        d.style.letterSpacing = (sp && !NON_LATIN.test(a.text || '')) ? sp + 'px' : '';
        if (ctx && ctx.selTb && ctx.selTb.el === d) els.tbColBtn.style.color = a.color;
    }

    function makeAnnEl(a) {
        if (a.type === 'hl') {
            const g = document.createElement('div');
            g.className = 'skpdf-hlg'; g.dataset.id = a.id;
            a.rects.forEach(r => {
                const d = document.createElement('div');
                d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${a.color}`;
                g.appendChild(d);
            });
            return g;
        }
        if (a.type === 'mark') {
            const s = document.createElementNS(NS_SVG, 'svg');
            s.setAttribute('class', 'skpdf-mark'); s.setAttribute('data-id', a.id);
            updateMarkEl(s, a);
            s.addEventListener('pointerdown', (e) => onTbPointerDown(e, s, a));
            return s;
        }
        if (a.type === 'ink') {
            const s = document.createElementNS(NS_SVG, 'svg');
            s.setAttribute('class', 'skpdf-ink'); s.setAttribute('data-id', a.id);
            const dd = inkPath(a.pts);
            const hit = document.createElementNS(NS_SVG, 'path');
            hit.setAttribute('class', 'hit'); hit.setAttribute('d', dd);
            hit.setAttribute('fill', 'none'); hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', Math.max(a.w, 12)); hit.setAttribute('stroke-linecap', 'round');
            const v = document.createElementNS(NS_SVG, 'path');
            v.setAttribute('class', 'v'); v.setAttribute('d', dd);
            v.setAttribute('fill', 'none'); v.setAttribute('stroke', a.color);
            v.setAttribute('stroke-width', a.w); v.setAttribute('stroke-linecap', 'round'); v.setAttribute('stroke-linejoin', 'round');
            s.appendChild(hit); s.appendChild(v);
            return s;
        }
        if (a.type === 'edit') return makeEditEl(a);
        const d = document.createElement('div');
        d.className = 'skpdf-tb'; d.dataset.id = a.id; d.dir = 'auto'; d.spellcheck = false;
        d.style.left = a.x + 'px'; d.style.top = a.y + 'px';
        d.textContent = a.text || '';
        applyTbStyle(d, a);
        d.contentEditable = isEditTool() ? 'true' : 'false';
        d.addEventListener('focus', () => selectTb(d, a));
        d.addEventListener('input', () => {
            a.text = (d.innerText || '').replace(/\n+$/, '');
            applyTbStyle(d, a); saveAnn(); placeTbBar();
        });
        d.addEventListener('blur', () => {
            commitText(d, a);
            if (ctx && ctx.selTb && ctx.selTb.el === d) hideTbBar();
        });
        d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') d.blur(); });
        d.addEventListener('paste', (e) => {
            e.preventDefault();
            const t = (e.clipboardData || window.clipboardData).getData('text');
            document.execCommand('insertText', false, t);
        });
        // drag to move (when the box isn't being edited); a plain click puts the caret in it
        d.addEventListener('mousedown', (e) => { if (document.activeElement !== d && d.contentEditable === 'true') e.preventDefault(); });
        d.addEventListener('pointerdown', (e) => onTbPointerDown(e, d, a));
        return d;
    }

    function focusEnd(d) {
        d.focus();
        try {
            const r = document.createRange(); r.selectNodeContents(d); r.collapse(false);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        } catch (e) {}
    }

    function onTbPointerDown(e, d, a) {
        if (!ctx || (ctx.tool !== 'text' && ctx.tool !== 'select')) return;
        if (e.button > 0 || document.activeElement === d) return;
        const idx = a.page, sx = e.clientX, sy = e.clientY;
        const p0 = clientToBase(idx, sx, sy), ax = a.x, ay = a.y;
        let moved = false;
        selectTb(d, a);
        try { d.setPointerCapture(e.pointerId); } catch (err) {}
        const mv = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
            moved = true;
            const p = clientToBase(idx, ev.clientX, ev.clientY);
            a.x = Math.max(0, ax + p.x - p0.x); a.y = Math.max(0, ay + p.y - p0.y);
            d.style.left = a.x + 'px'; d.style.top = a.y + 'px';
            placeTbBar();
        };
        const up = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); d.removeEventListener('pointercancel', up);
            try { d.releasePointerCapture(e.pointerId); } catch (err) {}
            if (moved) saveAnn(); else if (ctx && d.isConnected && d.contentEditable === 'true') focusEnd(d);
        };
        d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up); d.addEventListener('pointercancel', up);
    }

    function commitText(d, a) {
        if (!ctx) return;
        const list = ctx.ann[a.page];
        if (!list || list.indexOf(a) < 0) return; // already erased / undone
        a.text = (d.innerText || '').replace(/\n+$/, '');
        if (!a.text.trim()) {
            ctx.ann[a.page] = list.filter(x => x !== a);
            d.remove();
        } else if (!a._u) {
            a._u = true;
            ctx.undo.push({ op: 'add', anns: [a] });
        }
        saveAnn();
    }

    /* floating text-box toolbar (A- / A+ / delete / colour / letter spacing) */
    function selectTb(d, a) {
        if (!ctx) return;
        if (ctx.selTb && ctx.selTb.el !== d) ctx.selTb.el.classList.remove('sel');
        ctx.selTb = { el: d, a };
        d.classList.add('sel');
        els.tbBar.classList.toggle('mk', a.type === 'mark');
        els.tbBar.classList.toggle('ed', a.type === 'edit');
        els.tbColBtn.style.color = a.color;
        els.tbCol.classList.remove('show');
        placeTbBar();
    }
    function hideTbBar() {
        if (ctx && ctx.selTb) { ctx.selTb.el.classList.remove('sel'); ctx.selTb = null; }
        if (els.tbBar) { els.tbBar.classList.remove('show'); els.tbCol.classList.remove('show'); }
    }
    function placeTbBar() {
        const s = ctx && ctx.selTb;
        if (!s || !s.el.isConnected) { hideTbBar(); return; }
        const bar = els.tbBar, b = s.el.getBoundingClientRect();
        bar.classList.add('show');
        const w = bar.offsetWidth, h = bar.offsetHeight;
        const x = Math.min(window.innerWidth - w - 6, Math.max(6, b.left + b.width / 2 - w / 2));
        let y = b.top - h - 14;
        if (y < 58) y = b.bottom + 14;
        y = Math.min(window.innerHeight - h - 6, Math.max(6, y));
        bar.style.left = x + 'px'; bar.style.top = y + 'px';
    }
    function renderTbCol() {
        const s = ctx && ctx.selTb; if (!s) return;
        els.tbCol.innerHTML = colorGrid(TX_COLORS, s.a.color, 'Type text color');
    }
    function onTbBarClick(e) {
        const s = ctx && ctx.selTb; if (!s) return;
        const { el, a } = s;
        const sw = e.target.closest('.skpdf-cs');
        if (sw) {
            a.color = sw.dataset.c; if (a.type === 'edit') a._mod = true; else prefs.tx = a.color;
            applyTbStyle(el, a); savePrefs(); saveAnn();
            els.tbCol.classList.remove('show'); els.tbColBtn.style.color = a.color; updateColChip();
            return;
        }
        const b = e.target.closest('[data-a]'); if (!b) return;
        const act = b.dataset.a;
        if ((act === 'sm' || act === 'lg') && a.type === 'mark') {
            const f = act === 'lg' ? 1.2 : 1 / 1.2;
            a.w = Math.max(6, a.w * f); a.h = Math.max(6, a.h * f);
            if (a.kind !== 'circle') { prefs.markSize = Math.round(a.w); savePrefs(); }
            applyTbStyle(el, a); saveAnn(); placeTbBar();
            return;
        }
        if (act === 'sm' || act === 'lg') {
            let i = TX_SIZES.findIndex(v => v >= a.size); if (i < 0) i = TX_SIZES.length - 1;
            if (act === 'sm') i = TX_SIZES[i] < a.size ? i : i - 1; else i = TX_SIZES[i] > a.size ? i : i + 1;
            i = Math.min(TX_SIZES.length - 1, Math.max(0, i));
            const oldSize = a.size;
            a.size = TX_SIZES[i];
            if (a.type === 'edit') { a.asc *= a.size / oldSize; a.y = a.base - a.asc; a._mod = true; }   // keep the baseline where it was
            else prefs.size = a.size;
            applyTbStyle(el, a); savePrefs(); saveAnn(); placeTbBar(); pill(a.size + ' pt');
        } else if (act === 'del') {
            const list = ctx.ann[a.page] || [];
            hideTbBar();
            if (list.indexOf(a) >= 0) {
                ctx.ann[a.page] = list.filter(x => x !== a);
                if (a.type === 'mark' || (a.text && a.text.trim())) ctx.undo.push({ op: 'del', anns: [a] });
            }
            el.remove(); saveAnn();
        } else if (act === 'col') {
            renderTbCol(); els.tbCol.classList.toggle('show');
            els.tbCol.style.marginLeft = '0px';
            if (els.tbCol.classList.contains('show')) {
                const r = els.tbCol.getBoundingClientRect();
                const dx = r.left < 6 ? 6 - r.left : (r.right > window.innerWidth - 6 ? window.innerWidth - 6 - r.right : 0);
                els.tbCol.style.marginLeft = dx + 'px';
            }
        } else if (act === 'sp') {
            const i = SPACINGS.indexOf(a.sp || 0);
            a.sp = SPACINGS[(i + 1) % SPACINGS.length];
            applyTbStyle(el, a); saveAnn(); placeTbBar();
            pill('Letter spacing: ' + a.sp);
        }
    }

    /* freehand drawing */
    function startInk(e, L, idx) {
        const a = { id: uid(), type: 'ink', page: idx, color: prefs.ink, w: prefs.inkW, pts: [clientToBase(idx, e.clientX, e.clientY)] };
        const node = makeAnnEl(a);
        L.appendChild(node);
        const paths = node.querySelectorAll('path');
        try { L.setPointerCapture(e.pointerId); } catch (err) {}
        const mv = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
            (evs.length ? evs : [ev]).forEach(c => {
                const p = clientToBase(idx, c.clientX, c.clientY), l = a.pts[a.pts.length - 1];
                if (Math.hypot(p.x - l.x, p.y - l.y) >= 0.6) a.pts.push(p);
            });
            const dd = inkPath(a.pts);
            paths.forEach(p => p.setAttribute('d', dd));
        };
        const up = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            L.removeEventListener('pointermove', mv); L.removeEventListener('pointerup', up); L.removeEventListener('pointercancel', up);
            try { L.releasePointerCapture(e.pointerId); } catch (err) {}
            if (!ctx) return;
            (ctx.ann[idx] || (ctx.ann[idx] = [])).push(a);
            ctx.undo.push({ op: 'add', anns: [a] });
            saveAnn();
        };
        L.addEventListener('pointermove', mv); L.addEventListener('pointerup', up); L.addEventListener('pointercancel', up);
    }

    function addMark(L, a) {
        (ctx.ann[a.page] || (ctx.ann[a.page] = [])).push(a);
        ctx.undo.push({ op: 'add', anns: [a] });
        saveAnn();
    }
    function placeMark(L, idx, p) {
        const circle = prefs.mark === 'circle';
        const w = circle ? 70 : prefs.markSize, h = circle ? 32 : prefs.markSize;
        const a = { id: uid(), type: 'mark', kind: prefs.mark, page: idx, x: Math.max(0, p.x - w / 2), y: Math.max(0, p.y - h / 2), w, h, color: prefs.tx };
        L.appendChild(makeAnnEl(a));
        addMark(L, a);
    }
    function startCircle(e, L, idx) {
        const p0 = clientToBase(idx, e.clientX, e.clientY);
        const a = { id: uid(), type: 'mark', kind: 'circle', page: idx, x: p0.x, y: p0.y, w: 8, h: 8, color: prefs.tx };
        let node = null, moved = false;
        try { L.setPointerCapture(e.pointerId); } catch (err) {}
        const mv = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
            moved = true;
            const p = clientToBase(idx, ev.clientX, ev.clientY);
            a.x = Math.min(p0.x, p.x); a.y = Math.min(p0.y, p.y);
            a.w = Math.max(8, Math.abs(p.x - p0.x)); a.h = Math.max(8, Math.abs(p.y - p0.y));
            if (!node) { node = makeAnnEl(a); L.appendChild(node); } else updateMarkEl(node, a);
        };
        const up = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            L.removeEventListener('pointermove', mv); L.removeEventListener('pointerup', up); L.removeEventListener('pointercancel', up);
            try { L.releasePointerCapture(e.pointerId); } catch (err) {}
            if (!ctx) return;
            if (!moved) { a.w = 70; a.h = 32; a.x = Math.max(0, p0.x - 35); a.y = Math.max(0, p0.y - 16); node = makeAnnEl(a); L.appendChild(node); }
            addMark(L, a);
        };
        L.addEventListener('pointermove', mv); L.addEventListener('pointerup', up); L.addEventListener('pointercancel', up);
    }

    function onLayerDown(e, L, idx) {
        if (!ctx) return;
        const ae = document.activeElement;
        L._hadFocus = !!(ae && ae.classList && ae.classList.contains('skpdf-tb'));
        if (ctx.tool === 'draw' && e.target === L && e.button <= 0) { e.preventDefault(); startInk(e, L, idx); }
        else if (ctx.tool === 'text' && prefs.mark === 'circle' && e.target === L && e.button <= 0) { e.preventDefault(); startCircle(e, L, idx); }
    }

    function onLayerClick(e, L, idx) {
        if (!ctx) return;
        if (ctx.tool === 'text') {
            if (e.target !== L) return;                       // tapped an existing box: just edit it
            if (prefs.mark !== 'text') {
                if (prefs.mark !== 'circle') placeMark(L, idx, clientToBase(idx, e.clientX, e.clientY));
                return;
            }
            const p = clientToBase(idx, e.clientX, e.clientY);
            const a = { id: uid(), type: 'text', page: idx, x: Math.max(0, p.x), y: Math.max(0, p.y - prefs.size * 0.6),
                        size: prefs.size, color: prefs.tx, text: '' };
            (ctx.ann[idx] || (ctx.ann[idx] = [])).push(a);
            const d = makeAnnEl(a);
            L.appendChild(d);
            d.focus();
        } else if (ctx.tool === 'erase') {
            const node = e.target.closest && e.target.closest('[data-id]');
            if (!node) return;
            const a = (ctx.ann[idx] || []).find(x => x.id === node.getAttribute('data-id'));
            if (!a) return;
            ctx.ann[idx] = ctx.ann[idx].filter(x => x !== a);
            node.remove();
            ctx.undo.push({ op: 'del', anns: [a] });
            saveAnn();
        }
    }

    function undo() {
        if (!ctx) return;
        const op = ctx.undo.pop();
        if (!op) { pill('Nothing to undo'); return; }
        op.anns.forEach(a => {
            if (op.op === 'add') {
                ctx.ann[a.page] = (ctx.ann[a.page] || []).filter(x => x !== a);
                const n = els.pages.querySelector(`[data-id="${a.id}"]`); if (n) n.remove();
            } else {
                (ctx.ann[a.page] || (ctx.ann[a.page] = [])).push(a);
                if (ctx.rendered.has(a.page)) buildAnnLayer(a.page);
            }
        });
        saveAnn();
        pill('Undone');
    }

    /* floating, draggable tool palette */
    function savePal() {
        try { localStorage.setItem(LS_PAL, JSON.stringify({ x: parseFloat(els.annbar.style.left) || 0, y: parseFloat(els.annbar.style.top) || 0 })); } catch (e) {}
    }
    function movePalette(x, y) {
        const p = els.annbar, w = p.offsetWidth, h = p.offsetHeight;
        p.style.left = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4)) + 'px';
        p.style.top = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4)) + 'px';
    }
    function placePalette() {
        // always open in the default spot (left of the page, a bit above centre);
        // you can still drag it elsewhere while it's open
        movePalette(window.innerWidth * 0.15, window.innerHeight * 0.4);
    }
    function initPalette() {
        const g = els.grip; let off = null;
        g.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            const r = els.annbar.getBoundingClientRect();
            off = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            g.classList.add('drag'); hideFly();
            try { g.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });
        g.addEventListener('pointermove', (e) => { if (off) movePalette(e.clientX - off.dx, e.clientY - off.dy); });
        const end = () => { if (!off) return; off = null; g.classList.remove('drag'); savePal(); };
        g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
        window.addEventListener('resize', () => {
            if (els.annbar.classList.contains('open')) movePalette(parseFloat(els.annbar.style.left) || 0, parseFloat(els.annbar.style.top) || 0);
        });
    }

    /* flyout next to the palette: colours / widths / more actions */
    function colorGrid(list, cur, title, extra) {
        const cells = list.map(c => `<button class="skpdf-cs${c === '#ffffff' ? ' wh' : ''}" data-c="${c}" style="background:${c}" title="${c}">${c === cur ? CHK_SVG : ''}</button>`).join('');
        return `<div class="skpdf-cg"><div class="skpdf-cgt">${title}</div><div class="skpdf-cgg">${cells}</div>${extra || ''}</div>`;
    }
    function renderFly(kind) {
        const widths = '<div class="skpdf-cgw">' + INK_W.map(w => `<button class="skpdf-wb${w === prefs.inkW ? ' on' : ''}" data-w="${w}" title="${w}px"><i style="width:${w + 3}px;height:${w + 3}px"></i></button>`).join('') + '</div>';
        let h = '';
        if (kind === 'text') {
            h = '<div class="skpdf-flist">' + ['text', 'x', 'check', 'dot', 'circle'].map(m =>
                `<button class="skpdf-mi" data-m="${m}"><span class="skpdf-mic">${MARK_ICON[m]}</span><span>${MARK_LABEL[m]}</span><span class="skpdf-mckr">${m === prefs.mark ? ICON3.check : ''}</span></button>`).join('') + '</div>';
        } else if (kind === 'more') {
            h = `<div class="skpdf-frow"><button class="skpdf-fb" data-act="undo">${ICON.undo}Undo</button><button class="skpdf-fb" data-act="save">${ICON.save}Save PDF</button></div>`;
        } else {
            const t = kind === 'color' ? (ctx && ctx.tool) : kind;
            if (t === 'hl') h = colorGrid(HL_COLORS, prefs.hl, 'Highlight color');
            else if (t === 'draw') h = colorGrid(TX_COLORS, prefs.ink, 'Pen color', widths);
            else h = colorGrid(TX_COLORS, prefs.tx, 'Type text color');
        }
        els.annFly.innerHTML = h;
    }
    function showFly(kind, btn) {
        if (!ctx) return;
        ctx.fly = kind; ctx.flyBtn = btn;
        renderFly(kind);
        const f = els.annFly;
        f.style.visibility = 'hidden'; f.classList.add('show');
        const pr = els.annbar.getBoundingClientRect(), br = btn.getBoundingClientRect();
        const w = f.offsetWidth, h = f.offsetHeight;
        const left = pr.left + pr.width / 2 > window.innerWidth / 2;
        let x = left ? pr.left - w - 8 : pr.right + 8;
        x = Math.min(window.innerWidth - w - 6, Math.max(6, x));
        const y = Math.min(window.innerHeight - h - 6, Math.max(6, br.top + br.height / 2 - h / 2));
        f.style.left = x + 'px'; f.style.top = y + 'px'; f.style.visibility = '';
    }
    function hideFly() { els.annFly.classList.remove('show'); if (ctx) ctx.fly = null; }
    function toggleFly(kind, btn) { if (ctx && ctx.fly === kind) hideFly(); else showFly(kind, btn); }
    function updateTextIcon() { els.tTx.innerHTML = MARK_ICON[prefs.mark] || MARK_ICON.text; }
    function updateColChip() {
        const t = ctx && ctx.tool, on = t === 'hl' || t === 'draw' || t === 'text';
        els.colWrap.classList.toggle('show', !!on);
        if (on) els.chip.style.background = t === 'hl' ? prefs.hl : (t === 'draw' ? prefs.ink : prefs.tx);
    }
    function hintFor(t) {
        if (t === 'text' && prefs.mark !== 'text') return 'Tap the page to place a ' + MARK_NAME[prefs.mark];
        return HINTS[t] || '';
    }
    function onFlyClick(e) {
        if (!ctx) return;
        const cs = e.target.closest('.skpdf-cs');
        if (cs) { setColor(cs.dataset.c); return; }
        const wb = e.target.closest('.skpdf-wb');
        if (wb) { prefs.inkW = +wb.dataset.w; savePrefs(); renderFly(ctx.fly); return; }
        const mb = e.target.closest('[data-m]');
        if (mb) {
            prefs.mark = mb.dataset.m; savePrefs(); updateTextIcon();
            if (ctx.tool !== 'text') setTool('text'); else { hideFly(); pill(hintFor('text'), 1600); }
            updateColChip();
            return;
        }
        const fb = e.target.closest('[data-act]');
        if (fb) { hideFly(); if (fb.dataset.act === 'undo') undo(); else exportPdf(); }
    }
    function onToolBtn(t, btn) {
        if (!ctx) return;
        if (ctx.tool !== t) { setTool(t); if (FLY_TOOLS[t]) showFly(t, btn); }
        else if (FLY_TOOLS[t]) toggleFly(t, btn);
    }

    /* tool state */
    const isEditTool = () => !!ctx && (ctx.tool === 'text' || ctx.tool === 'select');
    function toggleAnn(force) {
        if (!ctx) return;
        const open = force !== undefined ? force : !els.annbar.classList.contains('open');
        els.annbar.classList.toggle('open', open);
        els.annBtn.classList.toggle('on', open);
        if (open) { placePalette(); setTool(ctx.tool || 'select'); }
        else setTool(null);
    }

    function setTool(t) {
        if (!ctx) return;
        const ae = document.activeElement;
        if (ae && ae.blur && ae.classList && ae.classList.contains('skpdf-tb')) ae.blur();
        hideTbBar(); hideFly();
        ctx.tool = t;
        root.classList.remove(...TOOL_CLASSES);
        if (t) root.classList.add('tool-' + t);
        [[els.tSel, 'select'], [els.tHl, 'hl'], [els.tDraw, 'draw'], [els.tTx, 'text'], [els.tEr, 'erase']]
            .forEach(([b, k]) => b.classList.toggle('on', t === k));
        els.hlBtn.style.display = 'none';
        if (t !== 'select' && ctx.editText) toggleEditText(false);   // other tools and editing existing text don't mix
        els.pages.querySelectorAll('.skpdf-tb').forEach(n => { n.contentEditable = (t === 'text' || t === 'select') ? 'true' : 'false'; });
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        updateColChip();
        if (t && hintFor(t)) pill(hintFor(t), 1600);
    }

    function setColor(c) {
        if (!ctx) return;
        if (ctx.tool === 'hl') prefs.hl = c;
        else if (ctx.tool === 'draw') prefs.ink = c;
        else if (ctx.tool === 'text') {
            prefs.tx = c;
            const s = ctx.selTb;
            if (s && s.el.isConnected) { s.a.color = c; applyTbStyle(s.el, s.a); saveAnn(); }
        }
        savePrefs(); hideFly(); updateColChip();   // pick a colour -> palette closes, colour is used from now on
    }

    /* highlight from a text selection */
    function updateHlBtn() {
        const sel = window.getSelection();
        if (!ctx || ctx.tool !== 'hl' || !pointerTouch || !sel || sel.isCollapsed || !sel.rangeCount || !els.pages.contains(sel.anchorNode)) {
            els.hlBtn.style.display = 'none'; return;
        }
        const b = sel.getRangeAt(0).getBoundingClientRect();
        const x = Math.min(window.innerWidth - 90, Math.max(90, b.left + b.width / 2));
        const y = b.bottom + 56 > window.innerHeight ? Math.max(70, b.top - 54) : b.bottom + 16;
        els.hlBtn.style.left = x + 'px'; els.hlBtn.style.top = y + 'px';
        els.hlBtn.style.display = 'block';
    }

    function captureHighlight() {
        if (!ctx || ctx.tool !== 'hl') return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!els.pages.contains(range.commonAncestorContainer)) return;
        const byPage = new Map();
        els.pages.querySelectorAll('.skpdf-tl span').forEach(sp => {
            if (!sp.firstChild || !range.intersectsNode(sp)) return;
            const r = document.createRange();
            r.selectNodeContents(sp);
            if (sp.contains(range.startContainer)) r.setStart(range.startContainer, range.startOffset);
            if (sp.contains(range.endContainer)) r.setEnd(range.endContainer, range.endOffset);
            const b = r.getBoundingClientRect();
            if (b.width < 1 || b.height < 1) return;
            const idx = +sp.closest('.skpdf-page').dataset.idx;
            const p1 = clientToBase(idx, b.left, b.top), p2 = clientToBase(idx, b.right, b.bottom);
            const rect = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
            if (!byPage.has(idx)) byPage.set(idx, []);
            byPage.get(idx).push(rect);
        });
        const made = [];
        byPage.forEach((rects, idx) => {
            const a = { id: uid(), type: 'hl', page: idx, color: prefs.hl, rects: mergeRects(rects) };
            (ctx.ann[idx] || (ctx.ann[idx] = [])).push(a);
            const L = ctx.pageEls[idx].querySelector('.skpdf-hl');
            if (L) L.appendChild(makeAnnEl(a));
            made.push(a);
        });
        try { sel.removeAllRanges(); } catch (e) {}
        els.hlBtn.style.display = 'none';
        if (made.length) { ctx.undo.push({ op: 'add', anns: made }); saveAnn(); pill('Highlighted'); }
    }

    function mergeRects(rects) {
        rects.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y));
        const out = [];
        rects.forEach(r => {
            const l = out[out.length - 1];
            if (l && Math.abs(l.y - r.y) < l.h * 0.5 && Math.abs(l.h - r.h) < l.h * 0.5 && r.x - (l.x + l.w) < 3 && r.x + r.w >= l.x) {
                const y0 = Math.min(l.y, r.y), y1 = Math.max(l.y + l.h, r.y + r.h), x1 = Math.max(l.x + l.w, r.x + r.w);
                l.x = Math.min(l.x, r.x); l.w = x1 - l.x; l.y = y0; l.h = y1 - y0;
            } else out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
        });
        return out;
    }

    /* ───────────── bake annotations into a real PDF (pdf-lib) ───────────── */
    // Pure-ish: all inputs passed in so it can be unit-tested outside the browser.
    const NO_LIGA = { liga: false, clig: false, dlig: false, rlig: false, calt: false, ccmp: false, locl: false, kern: false, mark: false, mkmk: false };
    async function buildAnnotatedPdf(bytes, sizes, ann, PDFLib, rasterText, fontOf) {
        const { PDFDocument, StandardFonts, rgb, LineCapStyle, BlendMode } = PDFLib;
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const pages = doc.getPages();
        const hex = (h) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
        let skipped = 0;
        const stdFont = async (info) => {
            const n = ((info && info.name) || '').replace(/^[A-Z]{6}\+/, '').toLowerCase();
            const bold = !!(info && info.bold), ital = !!(info && info.italic);
            let fam = 'Helvetica';
            if (/arial|helvet|sans|calibri|verdana|tahoma|segoe|roboto|inter|open|gothic/.test(n)) fam = 'Helvetica';
            else if (/courier|mono|consolas|menlo|typewriter/.test(n) || (info && info.mono)) fam = 'Courier';
            else if (/times|georgia|garamond|palat|cambria|minion|serif|roman|book|charter/.test(n) || (info && info.serif)) fam = 'Times';
            const k = fam === 'Times' ? 'TimesRoman' + (bold && ital ? 'BoldItalic' : bold ? 'Bold' : ital ? 'Italic' : '')
                : fam + (bold && ital ? 'BoldOblique' : bold ? 'Bold' : ital ? 'Oblique' : '');
            return doc.embedFont(StandardFonts[k] || StandardFonts.Helvetica);
        };
        const fcache = new Map();
        // 1) the full font of the same family (exact look), 2) the PDF's own subset when it has every glyph, 3) closest standard font
        const fontFor = async (a) => {
            const text = a.text || '';
            if (fontOf && a.font) {
                for (const exact of [true, false]) {
                    if (!exact && !a.font.loaded) continue;
                    const tag = (exact ? 'E:' : 'S:') + (a.font.name || '') + '|' + (a.font.loaded || '') + '|' + !!a.font.bold + !!a.font.italic;
                    try {
                        let ent = fcache.get('x:' + tag);
                        if (ent === undefined) {
                            ent = null;
                            const data = await fontOf(a, exact);
                            if (data) {
                                await loadScript(FONTKIT_SRC, () => !!window.fontkit);
                                const fk = window.fontkit, u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
                                const ft = fk.create(u8);
                                doc.registerFontkit(fk);
                                ent = { ft, font: await doc.embedFont(u8, { subset: true, features: NO_LIGA }) };   // no ligatures / kerning: they garble subset fonts
                            }
                            fcache.set('x:' + tag, ent);
                        }
                        if (ent) {
                            let ok = true;
                            for (const ch of text) { if (ch.trim() && !ent.ft.hasGlyphForCodePoint(ch.codePointAt(0))) { ok = false; break; } }
                            if (ok) return { font: ent.font, exact: true };
                        }
                    } catch (e) { fcache.set('x:' + tag, null); }
                }
            }
            const key = 's:' + (a.font ? (a.font.name || '') + a.font.bold + a.font.italic + a.font.mono + a.font.serif : '');
            if (!fcache.has(key)) fcache.set(key, await stdFont(a.font));
            return { font: fcache.get(key), exact: false };
        };
        for (const key of Object.keys(ann)) {
            const idx = +key, list = ann[key], page = pages[idx];
            if (!page || !list || !list.length) continue;
            if ((page.getRotation().angle % 360) !== 0) { skipped++; continue; }
            const cb = page.getCropBox();
            const kx = cb.width / sizes[idx].w, ky = cb.height / sizes[idx].h;
            const X = (x) => cb.x + x * kx, Y = (y) => cb.y + cb.height - y * ky;
            const ordered = list.slice().sort((p, q) => (q.type === 'edit') - (p.type === 'edit'));   // edits first, so marks stay on top
            for (const a of ordered) {
                if (a.type === 'edit') {
                    const txt = a.text || '';
                    let f = null;
                    if (txt.trim()) f = await fontFor(a);
                    const fsz = a.size * ky;
                    let wNew = 0;
                    if (f) { try { wNew = f.font.widthOfTextAtSize(txt, fsz) / kx; } catch (e) { wNew = a.w; } }
                    const ox = a.ox != null ? a.ox : a.x, oy = a.oy != null ? a.oy : a.y, ow = a.ow != null ? a.ow : a.w, os = a.osz || a.size;
                    // 1) wipe the original line where it was (even if the new text was moved elsewhere)
                    { const t0 = oy - os * 0.12, b0 = oy + os * 1.3;
                      page.drawRectangle({ x: X(ox - 2), y: Y(b0), width: (ow + 4) * kx, height: (b0 - t0) * ky, color: hex(a.bg || '#ffffff'), borderWidth: 0 }); }
                    // 2) background under the new text
                    const cw = Math.max(ow * a.size / os, wNew) + 4, top = a.y - a.size * 0.12, bot = a.y + a.size * 1.3;
                    page.drawRectangle({ x: X(a.x - 2), y: Y(bot), width: cw * kx, height: (bot - top) * ky, color: hex(a.bg || '#ffffff'), borderWidth: 0 });
                    if (!txt.trim()) continue;
                    let drawn = false;
                    try { f.font.encodeText(txt); } catch (e) { f = null; }
                    if (f) {
                        page.drawText(txt, { x: X(a.x), y: Y(a.base), size: fsz, font: f.font, color: hex(a.color) });
                        drawn = true;
                    } else if (rasterText) {
                        const b = Object.assign({}, a, { y: a.base - a.size * 0.95 });
                        const img = await rasterText(b);
                        if (img) {
                            const e2 = await doc.embedPng(img.png);
                            page.drawImage(e2, { x: X(b.x + img.dx), y: Y(b.y + img.dy + img.h), width: img.w * kx, height: img.h * ky });
                            drawn = true;
                        }
                    }
                    continue;
                }
                if (a.type === 'hl') {
                    for (const r of a.rects) {
                        // multiply blend = same look as the on-screen marker (text stays crisp and dark)
                        const o = BlendMode ? { blendMode: BlendMode.Multiply } : { opacity: 0.45 };
                        page.drawRectangle(Object.assign({ x: X(r.x), y: Y(r.y + r.h), width: r.w * kx, height: r.h * ky, color: hex(a.color), borderWidth: 0 }, o));
                    }
                } else if (a.type === 'mark') {
                    const col = hex(a.color), w = a.w * kx, h = a.h * ky, x0 = X(a.x), yT = Y(a.y);
                    const sw = (a.kind === 'circle' ? 2 : Math.max(1.5, Math.min(a.w, a.h) * 0.12)) * kx;
                    const cap = LineCapStyle ? LineCapStyle.Round : undefined;
                    const ln = (x1, y1, x2, y2) => page.drawLine({ start: { x: x0 + x1 * w, y: yT - y1 * h }, end: { x: x0 + x2 * w, y: yT - y2 * h }, thickness: sw, color: col, lineCap: cap });
                    if (a.kind === 'x') { ln(.1, .1, .9, .9); ln(.9, .1, .1, .9); }
                    else if (a.kind === 'check') { ln(.1, .55, .38, .85); ln(.38, .85, .92, .15); }
                    else if (a.kind === 'dot') page.drawEllipse({ x: x0 + w / 2, y: yT - h / 2, xScale: w / 2, yScale: h / 2, color: col, borderWidth: 0 });
                    else {
                        const W = a.w, H = a.h, i = 1, r = Math.min(W, H) / 2.6;
                        const d = `M${r + i} ${i}H${W - r - i}A${r} ${r} 0 0 1 ${W - i} ${r + i}V${H - r - i}A${r} ${r} 0 0 1 ${W - r - i} ${H - i}H${r + i}A${r} ${r} 0 0 1 ${i} ${H - r - i}V${r + i}A${r} ${r} 0 0 1 ${r + i} ${i}Z`;
                        page.drawSvgPath(d, { x: x0, y: yT, scale: kx, borderColor: col, borderWidth: sw });
                    }
                } else if (a.type === 'ink' && a.pts && a.pts.length) {
                    const col = hex(a.color), th = a.w * kx;
                    if (a.pts.length === 1) {
                        page.drawCircle({ x: X(a.pts[0].x), y: Y(a.pts[0].y), size: th / 2, color: col, borderWidth: 0 });
                    } else {
                        for (let i = 1; i < a.pts.length; i++) {
                            page.drawLine({ start: { x: X(a.pts[i - 1].x), y: Y(a.pts[i - 1].y) }, end: { x: X(a.pts[i].x), y: Y(a.pts[i].y) },
                                            thickness: th, color: col, lineCap: LineCapStyle ? LineCapStyle.Round : undefined });
                        }
                    }
                } else if (a.type === 'text' && a.text && a.text.trim()) {
                    if (NON_LATIN.test(a.text) && rasterText) {
                        const img = await rasterText(a);
                        if (img) {
                            const e = await doc.embedPng(img.png);
                            page.drawImage(e, { x: X(a.x + img.dx), y: Y(a.y + img.dy + img.h), width: img.w * kx, height: img.h * ky });
                            continue;
                        }
                    }
                    a.text.split('\n').forEach((ln, i) => {
                        let safe = ln;
                        try { font.encodeText(ln); } catch (e) { safe = ln.replace(NON_LATIN, '?'); }
                        if (!safe) return;
                        const yy = Y(a.y + a.size * 0.95 + i * a.size * 1.2), fs = a.size * ky;
                        if (a.sp) {
                            let x = X(a.x);
                            for (const ch of safe) { page.drawText(ch, { x, y: yy, size: fs, font, color: hex(a.color) }); x += font.widthOfTextAtSize(ch, fs) + a.sp * kx; }
                        } else page.drawText(safe, { x: X(a.x), y: yy, size: fs, font, color: hex(a.color) });
                    });
                }
            }
        }
        return { bytes: await doc.save(), skipped };
    }

    // Text with Urdu / Arabic / other non-Latin characters can't use the
    // built-in PDF fonts, so it's drawn by the browser (correct shaping + RTL)
    // and embedded as a transparent PNG.
    async function rasterText(a) {
        const S = 3, pad = 2, lh = a.size * 1.2, lines = a.text.split('\n');
        const font = `${a.size * S}px Helvetica, Arial, "Noto Nastaliq Urdu", "Noto Naskh Arabic", sans-serif`;
        const c = document.createElement('canvas'), g = c.getContext('2d');
        g.font = font;
        let w = 0; lines.forEach(l => { w = Math.max(w, g.measureText(l).width); });
        const W = Math.ceil(w) + pad * 2 * S, H = Math.ceil(lines.length * lh * S) + pad * 2 * S;
        c.width = W; c.height = H;
        g.font = font; g.fillStyle = a.color; g.textBaseline = 'alphabetic';
        const first = a.text.match(/[A-Za-z\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/);
        const rtl = !!(first && RTL_CHAR.test(first[0]));
        g.direction = rtl ? 'rtl' : 'ltr'; g.textAlign = rtl ? 'right' : 'left';
        lines.forEach((l, i) => g.fillText(l, rtl ? W - pad * S : pad * S, (0.95 * a.size + i * lh) * S + pad * S));
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        return { png: new Uint8Array(await blob.arrayBuffer()), w: W / S, h: H / S, dx: -pad, dy: -pad };
    }


    /* ───────────── edit existing text (keeps the original font) ───────────── */
    // palette "Edit text" button: select-tool mode + click-to-edit on the page's own text
    function togglePalEdit() {
        if (!ctx) return;
        if (ctx.editText) { toggleEditText(false); return; }
        if (ctx.tool !== 'select') setTool('select');
        toggleEditText(true);
    }

    function toggleEditText(force) {
        if (!ctx) return;
        const on = force !== undefined ? force : !ctx.editText;
        if (on === !!ctx.editText) return;
        if (on && ctx.rotation) { pill('Turn the page back to 0° to edit its text', 2400); return; }
        ctx.editText = on;
        root.classList.toggle('edit-text', on);
        els.editBtn.classList.toggle('on', on);
        if (els.tEd) els.tEd.classList.toggle('on', on);
        els.editBtn.querySelector('span').textContent = on ? 'Stop editing' : 'Edit text';
        els.pages.querySelectorAll('.skpdf-ed').forEach(n => { n.contentEditable = on ? 'true' : 'false'; });
        if (!on) { const ae = document.activeElement; if (ae && ae.classList && ae.classList.contains('skpdf-ed')) ae.blur(); }
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        if (on) pill('Click a line of text to change it', 2400);
    }

    // geometry of a text run in page ("base") units, top-left origin
    function runGeom(idx, i) {
        const T = ctx.text[idx]; if (!T) return null;
        const it = T.items[i];
        if (!it || it._g !== undefined) return it ? it._g : null;
        it._g = null;
        if (!it.str || !it.transform) return null;
        const vp = T.page.getViewport({ scale: 1, rotation: 0 });
        const m = window.pdfjsLib.Util.transform(vp.transform, it.transform);
        const size = Math.hypot(m[0], m[1]);
        if (size < 1 || Math.abs(m[1]) > size * 0.05 || m[0] < 0) return null;   // rotated / mirrored text: not editable
        const st = T.styles[it.fontName] || {};
        const asc = st.ascent ? st.ascent * size : (st.descent ? (1 + st.descent) * size : size);
        it._g = { x: m[4], base: m[5], size, asc, w: it.width * vp.scale, key: idx + ':' + i };
        return it._g;
    }

    function sampleColors(idx, x, top, w, h) {
        const out = { bg: '#ffffff', fg: '#000000' };
        const el = ctx.pageEls[idx], cv = el && el.querySelector('canvas');
        if (!cv) return out;
        const k = cv.width / ctx.sizes[idx].w;
        let g; try { g = cv.getContext('2d'); } catch (e) { return out; }
        const at = (bx, by) => {
            try {
                const X = Math.max(0, Math.min(cv.width - 1, Math.round(bx * k))), Y = Math.max(0, Math.min(cv.height - 1, Math.round(by * k)));
                const d = g.getImageData(X, Y, 1, 1).data; return [d[0], d[1], d[2]];
            } catch (e) { return null; }
        };
        // background: the colour that dominates just outside the text box
        const votes = new Map(); let best = null, bn = 0;
        const pts = [];
        for (let t = 0.15; t <= 0.9; t += 0.25) { pts.push([x - 3, top + h * t], [x + w + 3, top + h * t]); }
        for (let t = 0; t <= 1; t += 0.2) { pts.push([x + w * t, top - 2], [x + w * t, top + h + 2]); }
        pts.forEach(([bx, by]) => {
            const p = at(bx, by); if (!p) return;
            const key = p.map(v => v >> 4).join(','); const n = (votes.get(key) || 0) + 1; votes.set(key, n);
            if (n > bn) { bn = n; best = p; }
        });
        const bg = best || [255, 255, 255];
        const hex = (p) => '#' + p.map(v => v.toString(16).padStart(2, '0')).join('');
        out.bg = hex(bg);
        // text colour: the pixel inside the run that differs most from the background
        try {
            const X0 = Math.max(0, Math.floor(x * k)), Y0 = Math.max(0, Math.floor(top * k));
            const W = Math.min(cv.width - X0, Math.ceil(w * k)), H = Math.min(cv.height - Y0, Math.ceil(h * k));
            if (W > 0 && H > 0) {
                const d = g.getImageData(X0, Y0, W, H).data;
                let far = 0, fp = null;
                for (let i = 0; i < d.length; i += 4) {
                    const dist = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
                    if (dist > far) { far = dist; fp = [d[i], d[i + 1], d[i + 2]]; }
                }
                if (fp && far > 90) out.fg = hex(fp);
            }
        } catch (e) {}
        return out;
    }

    function fontInfoFor(T, it) {
        const st = T.styles[it.fontName] || {};
        let fo = null;
        try { fo = T.page.commonObjs.get(it.fontName); } catch (e) {}
        const name = (fo && fo.name) || '';
        const info = {
            loaded: (fo && fo.loadedName) || '', name,
            bold: !!(fo && (fo.bold || fo.black)) || /bold|black|heavy|semibold|demi/i.test(name),
            italic: !!(fo && fo.italic) || /italic|oblique/i.test(name),
            mono: !!(fo && fo.isMonospace), serif: !!(fo && fo.isSerifFont)
        };
        if (fo && info.loaded) ctx.fontObjs[info.loaded] = fo;
        const fam = st.fontFamily || (info.mono ? 'monospace' : info.serif ? 'serif' : 'sans-serif');
        return { info, css: (info.loaded ? '"' + info.loaded + '",' : '') + fam };
    }

    function hitRun(idx, e) {
        const T = ctx.text[idx]; if (!T) return -1;
        const p = clientToBase(idx, e.clientX, e.clientY);
        let hit = -1, hitArea = Infinity;
        for (let i = 0; i < T.items.length; i++) {
            const g = runGeom(idx, i); if (!g) continue;
            if (p.x >= g.x - 2 && p.x <= g.x + g.w + 2 && p.y >= g.base - g.asc - 1 && p.y <= g.base + g.size * 0.3) {
                const area = g.w * g.size;
                if (area < hitArea) { hit = i; hitArea = area; }
            }
        }
        return hit;
    }

    // turn one original text run into an editable annotation (or return the one that already exists)
    function openEditAt(idx, hit) {
        const T = ctx.text[idx], g = runGeom(idx, hit), it = T.items[hit];
        const list = ctx.ann[idx] || (ctx.ann[idx] = []);
        const old = list.find(a => a.type === 'edit' && a.key === g.key);
        if (old) { const n = els.pages.querySelector(`[data-id="${old.id}"]`); return n ? { a: old, d: n, fresh: false } : null; }
        const top = g.base - g.asc;
        const col = sampleColors(idx, g.x, top, g.w, g.size * 1.2);
        const f = fontInfoFor(T, it);
        const a = { id: uid(), type: 'edit', page: idx, key: g.key, x: g.x, y: top, base: g.base, w: g.w, size: g.size, asc: g.asc,
                    text: it.str, orig: it.str, color: col.fg, bg: col.bg, font: f.info, ff: f.css,
                    ox: g.x, oy: top, ow: g.w, osz: g.size };
        list.push(a);
        const L = ctx.pageEls[idx].querySelector('.skpdf-ann');
        const d = makeEditEl(a);
        if (L) L.appendChild(d);
        return { a, d, fresh: true };
    }

    function onEditClick(e) {
        if (!ctx || !ctx.editText) return;
        if (e.target.closest('.skpdf-ed')) return;
        const pg = e.target.closest('.skpdf-page'); if (!pg) return;
        const idx = ctx.pageEls.indexOf(pg); if (idx < 0) return;
        if (!ctx.text[idx]) return;
        const hit = hitRun(idx, e);
        if (hit < 0) { pill('Click directly on a line of text', 1500); return; }
        const r = openEditAt(idx, hit);
        if (r) focusEnd(r.d);
    }

    // press + drag on an untouched original line moves it without having to edit it first (mouse / pen)
    function onEditDown(e) {
        if (!ctx || !ctx.editText || e.button > 0 || e.pointerType === 'touch') return;
        if (e.target.closest('.skpdf-ed')) return;
        const pg = e.target.closest('.skpdf-page'); if (!pg) return;
        const idx = ctx.pageEls.indexOf(pg); if (idx < 0 || !ctx.text[idx]) return;
        const hit = hitRun(idx, e); if (hit < 0) return;
        const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
        const mv = (ev) => {
            if (ev.pointerId !== pid || Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
            cleanup();
            const r = openEditAt(idx, hit); if (!r) return;
            r.a._mod = true;
            dragEd({ clientX: sx, clientY: sy, pointerId: pid }, r.d, r.a, r.d, false);
            try { window.getSelection().removeAllRanges(); } catch (err) {}
        };
        const cleanup = () => { document.removeEventListener('pointermove', mv, true); document.removeEventListener('pointerup', cleanup, true); document.removeEventListener('pointercancel', cleanup, true); };
        document.addEventListener('pointermove', mv, true); document.addEventListener('pointerup', cleanup, true); document.addEventListener('pointercancel', cleanup, true);
    }

    /* ───────────── exact font for edited text ─────────────
       PDFs embed only a SUBSET of each font (just the letters the page uses), so new letters can't be drawn
       with the embedded copy. For subset fonts we fetch the FULL font of the same family (Google Fonts via
       fontsource: Lato, Roboto, Open Sans …; Times/Arial/Calibri/Cambria/Courier/Georgia map to their
       metric-identical twins Tinos/Arimo/Carlito/Caladea/Cousine/Gelasio) and use it for both the on-screen
       editor and the saved PDF. */
    const SUBSET_RE = /^[A-Z]{6}\+/;
    const SYS_ALIAS = { timesnewroman: 'tinos', times: 'tinos', arial: 'arimo', helvetica: 'arimo', calibri: 'carlito', cambria: 'caladea', couriernew: 'cousine', courier: 'cousine', georgia: 'gelasio' };
    const EXACT_FONTS = new Map();
    function exactCandidates(info) {
        const raw = (info.name || '').replace(SUBSET_RE, '');
        const parts = raw.split(/[-,]/);
        let fam = (parts.shift() || '').replace(/(PSMT|MT|PS)$/, '');
        const sty = (parts.join(' ') + ' ' + raw).toLowerCase();
        const key = fam.replace(/[\s_]+/g, '').toLowerCase();
        const slug = SYS_ALIAS[key] || fam.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
        if (!slug) return [];
        let w = 400;
        if (/thin|hairline/.test(sty)) w = 100; else if (/extra-?light|ultra-?light/.test(sty)) w = 200; else if (/light/.test(sty)) w = 300;
        else if (/semi-?bold|demi/.test(sty)) w = 600; else if (/extra-?bold|ultra-?bold|heavy/.test(sty)) w = 800; else if (/black/.test(sty)) w = 900;
        else if (/medium/.test(sty)) w = 500; else if (info.bold || /bold/.test(sty)) w = 700;
        const it = (info.italic || /italic|oblique/.test(sty)) ? 'italic' : 'normal';
        const ws = [w, w >= 600 ? 700 : 400].filter((v, i, a) => a.indexOf(v) === i);
        const out = [];
        ws.forEach(x => ['latin', 'latin-ext'].forEach(sub => out.push(`https://cdn.jsdelivr.net/npm/@fontsource/${slug}/files/${slug}-${sub}-${x}-${it}.woff`)));
        return out;
    }
    function loadExactFont(info) {
        if (!info || !SUBSET_RE.test(info.name || '')) return Promise.resolve(null);
        const k = [info.name, info.bold, info.italic].join('|');
        if (EXACT_FONTS.has(k)) return EXACT_FONTS.get(k);
        const pr = (async () => {
            for (const url of exactCandidates(info)) {
                try {
                    const r = await fetch(url);
                    if (!r.ok) continue;
                    const bytes = new Uint8Array(await r.arrayBuffer());
                    let h = 0; for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
                    const name = 'skx' + h.toString(36);
                    const ff = new FontFace(name, bytes.slice().buffer);
                    await ff.load(); document.fonts.add(ff);
                    return { name, bytes, url };
                } catch (e) { /* try the next candidate */ }
            }
            return null;
        })();
        EXACT_FONTS.set(k, pr);
        return pr;
    }
    // swap the editor over to the exact font as soon as it has loaded
    async function useExactFont(a, d) {
        if (!a.font || !SUBSET_RE.test(a.font.name || '')) return;
        const ex = await loadExactFont(a.font);
        if (!ex) {
            if (ctx && !ctx._xfWarned) { ctx._xfWarned = true; pill('Original font not available online – using the closest match', 2600); }
            return;
        }
        if (!d.isConnected && !a.ff) return;
        if (a.ff.indexOf('"' + ex.name + '"') < 0) a.ff = '"' + ex.name + '",' + a.ff;
        a.xf = ex.name;
        d.style.fontFamily = a.ff;
        if (ctx && ctx.selTb && ctx.selTb.el === d) placeTbBar();
        saveAnn();
    }

    // position / size / colour of an edited line. The ::before cover always sits on the ORIGINAL line,
    // so the old text stays hidden after the new one is moved, shrunk or grown.
    function edLayout(d, a) {
        const s = a.size, os = a.osz || a.size;
        const ox = a.ox != null ? a.ox : a.x, oy = a.oy != null ? a.oy : a.y, ow = a.ow != null ? a.ow : a.w;
        d.style.left = (a.x - 2) + 'px'; d.style.top = (a.y - s * 0.12) + 'px';
        d.style.padding = `${s * 0.12}px 2px ${s * 0.3}px 2px`;
        d.style.minWidth = (ow * s / os) + 'px';
        d.style.fontSize = s + 'px'; d.style.color = a.color; d.style.background = a.bg; d.style.fontFamily = a.ff;
        d.style.setProperty('--cx', (ox - a.x) + 'px');
        d.style.setProperty('--cy', ((oy - os * 0.12) - (a.y - s * 0.12)) + 'px');
        d.style.setProperty('--cw', (ow + 4) + 'px');
        d.style.setProperty('--ch', (os * 1.42) + 'px');
        d.style.setProperty('--cb', a.bg);
    }

    // drag an edited line (from the text itself or from the bar's grab handle)
    function dragEd(e, d, a, target, focusOnTap) {
        const idx = a.page, sx = e.clientX, sy = e.clientY;
        const p0 = clientToBase(idx, sx, sy), ax = a.x, ay = a.y;
        let moved = false;
        selectTb(d, a);
        try { target.setPointerCapture(e.pointerId); } catch (err) {}
        const mv = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
            moved = true;
            const p = clientToBase(idx, ev.clientX, ev.clientY);
            a.x = Math.max(0, ax + p.x - p0.x); a.y = Math.max(0, ay + p.y - p0.y);
            a.base = a.y + a.asc;
            edLayout(d, a); placeTbBar();
        };
        const up = (ev) => {
            if (ev.pointerId !== e.pointerId) return;
            target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
            try { target.releasePointerCapture(e.pointerId); } catch (err) {}
            if (moved) { a._mod = true; if (!a._u && ctx && (ctx.ann[a.page] || []).indexOf(a) >= 0) { a._u = true; ctx.undo.push({ op: 'add', anns: [a] }); } saveAnn(); }
            else if (focusOnTap && ctx && d.isConnected && d.contentEditable === 'true') focusEnd(d);
        };
        target.addEventListener('pointermove', mv); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
    }

    function makeEditEl(a) {
        const d = document.createElement('div');
        d.className = 'skpdf-ed'; d.dataset.id = a.id; d.dir = 'auto'; d.spellcheck = false;
        edLayout(d, a);
        d.textContent = a.text;
        d.contentEditable = ctx && ctx.editText ? 'true' : 'false';
        useExactFont(a, d);
        d.addEventListener('focus', () => selectTb(d, a));
        d.addEventListener('input', () => { a.text = (d.innerText || '').replace(/\n+$/, ''); saveAnn(); placeTbBar(); });
        d.addEventListener('blur', () => {
            commitEdit(d, a);
            if (ctx && ctx.selTb && ctx.selTb.el === d) hideTbBar();
        });
        d.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); d.blur(); }
        });
        d.addEventListener('paste', (e) => {
            e.preventDefault();
            const t = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\s*\n\s*/g, ' ');
            document.execCommand('insertText', false, t);
        });
        // press + drag moves the line; a plain click puts the caret in it
        d.addEventListener('mousedown', (e) => { if (document.activeElement !== d && d.contentEditable === 'true') e.preventDefault(); });
        d.addEventListener('pointerdown', (e) => {
            if (!ctx || !ctx.editText || e.button > 0 || document.activeElement === d) return;
            dragEd(e, d, a, d, true);
        });
        return d;
    }

    function commitEdit(d, a) {
        if (!ctx) return;
        const list = ctx.ann[a.page];
        if (!list || list.indexOf(a) < 0) return;
        a.text = (d.innerText || '').replace(/\n+$/, '');
        if (a.text === a.orig && !a._mod) {            // nothing changed: put the original back
            ctx.ann[a.page] = list.filter(x => x !== a);
            d.remove();
        } else if (!a._u) {
            a._u = true;
            ctx.undo.push({ op: 'add', anns: [a] });
        }
        saveAnn();
    }

    async function annotatedBytes() {
        await loadPdfLib();
        const raw = await pdf.getData();
        const clean = {};
        Object.keys(ctx.ann).forEach(k => {
            const l = ctx.ann[k].filter(a => a.type !== 'text' || (a.text && a.text.trim()));
            if (l.length) clean[k] = l;
        });
        const fontOf = async (a, exact) => {
            if (exact) { const ex = await loadExactFont(a.font); return ex ? ex.bytes : null; }
            const fo = ctx.fontObjs && a.font && ctx.fontObjs[a.font.loaded]; return (fo && fo.data) || null;
        };
        return buildAnnotatedPdf(raw, ctx.sizes, clean, window.PDFLib, rasterText, fontOf);
    }

    async function exportPdf() {
        if (!ctx || !pdf) return;
        if (!annCount()) { pill('Add a highlight, drawing or some text first', 1800); return; }
        if (exportPdf._busy) return;
        exportPdf._busy = true;
        pill('Preparing PDF…', 4000);
        try {
            const name = ctx.name;
            const out = await annotatedBytes();
            const url = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
            const a = document.createElement('a');
            a.href = url; const hasEdit = Object.keys(ctx.ann).some(k => ctx.ann[k].some(x => x.type === 'edit'));
            a.download = name.replace(/\.pdf$/i, '') + (hasEdit ? '-edited.pdf' : '-annotated.pdf');
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            pill(out.skipped ? `Saved — ${out.skipped} page(s) with built-in rotation were skipped` : 'Annotated PDF saved', 2500);
        } catch (err) {
            pill('Could not save: ' + ((err && err.message) || err), 3500);
        } finally { exportPdf._busy = false; }
    }

    /* ───────────── view menu: page layout, zoom modes, read / full screen ───────────── */
    function loadView() {
        const d = { mode: 'single', cover: false, scroll: true };
        try { return Object.assign(d, JSON.parse(localStorage.getItem(LS_VIEW) || '{}')); } catch (e) { return d; }
    }
    function saveView() { try { localStorage.setItem(LS_VIEW, JSON.stringify(ctx.view)); } catch (e) {} }

    function spreadFor(idx) {
        const n = ctx.sizes.length;
        if (ctx.view.mode !== 'two') return [idx];
        let s;
        if (ctx.view.cover) { if (idx === 0) return [0]; s = idx % 2 === 1 ? idx : idx - 1; }
        else s = idx - (idx % 2);
        return s + 1 < n ? [s, s + 1] : [s];
    }
    function layoutVisible() {
        if (!ctx) return;
        if (ctx.view.scroll) { ctx.pageEls.forEach(el => { el.style.display = ''; }); return; }
        const vis = spreadFor(ctx.current - 1);
        ctx.pageEls.forEach((el, i) => { el.style.display = vis.indexOf(i) >= 0 ? '' : 'none'; });
        els.scroll.scrollTop = 0;
    }
    function applyView() {
        if (!ctx) return;
        const two = ctx.view.mode === 'two';
        els.pages.classList.toggle('two', two);
        els.pages.classList.toggle('cover', two && !!ctx.view.cover);
        layoutVisible();
    }
    function stepPage(dir) {
        if (!ctx) return;
        if (ctx.view.scroll) { goToPage(ctx.current + dir); return; }
        const vis = spreadFor(ctx.current - 1);
        goToPage(dir > 0 ? vis[vis.length - 1] + 2 : vis[0]);
    }
    function changeView() {
        const cur = ctx.current, kind = ctx.zoomKind;
        saveView();
        applyView();
        if (kind) applyZoom(kind, true);
        goToPage(cur, true);
    }

    function fitTo(kind, quiet) {
        if (!ctx || !ctx.sizes.length) return;
        const swap = ctx.rotation % 180 !== 0;
        const sz = ctx.sizes[Math.min(ctx.current, ctx.sizes.length) - 1];
        const pw = swap ? sz.h : sz.w, ph = swap ? sz.w : sz.h;
        const cols = ctx.view.mode === 'two' ? 2 : 1;
        const availW = els.scroll.clientWidth - (window.innerWidth < 700 ? 16 : 40) - (cols - 1) * 14;
        const availH = els.scroll.clientHeight - 32;
        const s = kind === 'height' ? availH / ph : Math.min(availW / (pw * cols), availH / ph);
        ctx.fitMode = true; ctx.fitKind = kind;
        setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)));
        ctx.zoomKind = kind;
        goToPage(ctx.current, true);
        if (!quiet) pill(kind === 'height' ? 'Fit height' : 'Page level');
    }
    async function fitContent(quiet) {
        if (!ctx || !pdf) return;
        const c = ctx, idx = c.current - 1;
        try {
            const page = await pdf.getPage(idx + 1);
            const vp = page.getViewport({ scale: 1, rotation: c.rotation });
            const tc = await page.getTextContent();
            if (ctx !== c) return;
            let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
            tc.items.forEach(it => {
                if (!it.str || !it.str.trim()) return;
                const a = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
                const b = vp.convertToViewportPoint(it.transform[4] + it.width, it.transform[5] + it.height);
                x0 = Math.min(x0, a[0], b[0]); x1 = Math.max(x1, a[0], b[0]);
                y0 = Math.min(y0, a[1], b[1]); y1 = Math.max(y1, a[1], b[1]);
            });
            if (x0 > x1) { fitTo('width', quiet); return; }
            const pad = 10;
            const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (els.scroll.clientWidth - 24) / (x1 - x0 + 2 * pad)));
            c.fitMode = false;
            setScale(s);
            c.zoomKind = 'content';
            const el = c.pageEls[idx];
            els.scroll.scrollLeft = el.offsetLeft + (x0 - pad) * c.scale;
            els.scroll.scrollTop = el.offsetTop + (y0 - pad) * c.scale;
            if (!quiet) pill('Visible content');
        } catch (e) { if (ctx === c) fitTo('width', quiet); }
    }
    function applyZoom(kind, quiet) {
        if (!ctx) return;
        if (kind === 'actual') { ctx.fitMode = false; setScale(1); ctx.zoomKind = 'actual'; if (!quiet) pill('Actual size'); }
        else if (kind === 'width') fitWidth(quiet);
        else if (kind === 'content') fitContent(quiet);
        else fitTo(kind, quiet);
    }
    function refit() {
        if (!ctx) return;
        if (ctx.zoomKind === 'content') fitContent(true);
        else if (ctx.fitMode) { if (ctx.fitKind === 'page' || ctx.fitKind === 'height') fitTo(ctx.fitKind, true); else fitWidth(true); }
    }

    function toggleRead(force) {
        if (!ctx) return;
        const on = force !== undefined ? force : !root.classList.contains('read');
        if (on && els.annbar.classList.contains('open')) toggleAnn(false);
        hideViewMenu();
        root.classList.toggle('read', on);
        setTimeout(refit, 60);
        if (on) pill('Read mode — press Esc to exit', 2200);
    }
    function toggleFull() {
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        if (fs) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} return; }
        const rq = root.requestFullscreen || root.webkitRequestFullscreen;
        if (!rq) { pill('Full screen isn’t supported on this browser', 2400); return; }
        try { const r = rq.call(root); if (r && r.catch) r.catch(() => pill('Could not enter full screen', 2200)); } catch (e) { pill('Could not enter full screen', 2200); }
    }

    function renderViewMenu() {
        const v = ctx.view, two = v.mode === 'two', fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const row = (id, label, icon, checked, dis) =>
            `<button class="skpdf-mi" data-id="${id}"${dis ? ' disabled' : ''}><span class="skpdf-mck">${checked ? ICON3.check : ''}</span><span class="skpdf-mic">${icon}</span><span>${label}</span></button>`;
        const sep = '<div class="skpdf-msep"></div>';
        els.viewMenu.innerHTML =
            row('single', 'Single-page view', ICON3.single, !two) +
            row('two', 'Two-page view', ICON3.two, two) +
            row('cover', 'Show cover page', ICON3.cover, two && v.cover, !two) + sep +
            row('scroll', 'Enable scrolling', ICON3.scroll, v.scroll) + sep +
            row('actual', 'Actual size', ICON3.actual, ctx.zoomKind === 'actual') +
            row('page', 'Zoom to page level', ICON3.page, ctx.zoomKind === 'page') +
            row('width', 'Fit to width', ICON3.width, ctx.zoomKind === 'width') +
            row('height', 'Fit height', ICON3.height, ctx.zoomKind === 'height') +
            row('content', 'Fit visible content', ICON3.content, ctx.zoomKind === 'content') + sep +
            row('read', 'Read mode', ICON3.read, false) +
            row('full', fs ? 'Exit full screen mode' : 'Full screen mode', ICON3.full, false);
    }
    function hideViewMenu() { if (els.viewMenu) els.viewMenu.classList.remove('show'); if (els.viewBtn) els.viewBtn.classList.remove('on'); }
    function toggleViewMenu() {
        if (!ctx) return;
        if (els.viewMenu.classList.contains('show')) { hideViewMenu(); return; }
        renderViewMenu();
        const bar = root.querySelector('.skpdf-bar').getBoundingClientRect();
        els.viewMenu.style.top = (bar.bottom + 6) + 'px';
        els.viewMenu.classList.add('show'); els.viewBtn.classList.add('on');
    }
    function onViewMenuClick(e) {
        const b = e.target.closest('.skpdf-mi');
        if (!b || b.disabled || !ctx) return;
        const id = b.dataset.id, v = ctx.view;
        hideViewMenu();
        if (id === 'single' || id === 'two') { if (v.mode !== id) { v.mode = id; changeView(); } }
        else if (id === 'cover') { v.cover = !v.cover; changeView(); }
        else if (id === 'scroll') { v.scroll = !v.scroll; changeView(); pill(v.scroll ? 'Scrolling on' : 'One page at a time — scroll past the edge or swipe to turn the page', 2600); }
        else if (id === 'read') toggleRead();
        else if (id === 'full') toggleFull();
        else applyZoom(id);
    }

    /* ───────────── download / print / keys ───────────── */
    function download() {
        if (!ctx) return;
        const a = document.createElement('a');
        a.href = ctx.downloadUrl; a.target = '_blank'; a.rel = 'noopener';
        a.download = ctx.name;
        document.body.appendChild(a); a.click(); a.remove();
    }

    async function printDoc() {
        if (!ctx) return;
        let src = ctx.url, tmp = null;
        if (annCount()) {
            try {
                const out = await annotatedBytes();
                tmp = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
                src = tmp;
            } catch (e) { /* fall back to the original file */ }
        }
        const f = document.createElement('iframe');
        f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        f.src = src;
        f.onload = () => {
            try { f.contentWindow.focus(); f.contentWindow.print(); }
            catch (e) { window.open(src, '_blank'); }
            setTimeout(() => { f.remove(); if (tmp) URL.revokeObjectURL(tmp); }, 60000);
        };
        document.body.appendChild(f);
    }

    function onKey(e) {
        if (!root || !root.classList.contains('open') || !ctx) return;
        if (activeViewer && activeViewer !== api && activeViewer.isOpen()) return;
        if (e.target && e.target.isContentEditable) {
            if (e.key === 'Escape') { e.target.blur(); e.preventDefault(); }
            return;
        }
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input') return;
        const k = e.key;
        if (k === 'Escape') {
            if (els.viewMenu.classList.contains('show')) hideViewMenu();
            else if (root.classList.contains('read')) toggleRead(false);
            else if (els.search.classList.contains('open')) toggleSearch();
            else if (els.annbar.classList.contains('open')) toggleAnn(false);
            else if (ctx.editText) toggleEditText(false);
            else close();
            e.preventDefault(); e.stopPropagation();
        }
        else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z' && els.annbar.classList.contains('open')) { e.preventDefault(); undo(); }
        else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'f') { e.preventDefault(); if (!els.search.classList.contains('open')) toggleSearch(); else els.q.focus(); }
        else if (k === '+' || k === '=') { zoomBy(1.2); }
        else if (k === '-') { zoomBy(1 / 1.2); }
        else if (k === '0') { fitWidth(); }
        else if (k.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) { rotate(); }
        else if (k === 'ArrowRight' || k === 'PageDown') { if (k === 'PageDown') return; stepPage(1); e.preventDefault(); }
        else if (k === 'ArrowLeft') { stepPage(-1); e.preventDefault(); }
        else if (k === 'Home') { goToPage(1); e.preventDefault(); }
        else if (k === 'End') { goToPage(ctx.sizes.length); e.preventDefault(); }
    }

    api = {
        open, close: () => close(), refit: () => { if (ctx) refit(); },
        isOpen: () => !!(root && root.classList.contains('open')),
        el: () => { build(); return root; },
        info: () => ctx ? { id: ctx.id, name: ctx.name } : null,
        setTitleBtn: (split) => {
            build();
            const b = root.querySelector('#skPdfSplitBtn');
            b.title = split ? 'Change the PDF in this pane' : 'Open a second PDF side by side';
        },
        _buildAnnotatedPdf: buildAnnotatedPdf
    };
    viewers.push(api);
    return api;
    }

    /* ───────────── split view manager ───────────── */
    const LS_SPLIT = 'sk_pdf_split_pct';
    const Split = (() => {
        let A = null, B = null, left = null, right = null, divider = null, on = false;
        let pct = 50;
        try { pct = Math.min(80, Math.max(20, parseFloat(localStorage.getItem(LS_SPLIT)) || 50)); } catch (e) {}

        function vertical() { return window.matchMedia('(max-width:700px)').matches; }
        function setPct(p) {
            pct = Math.min(80, Math.max(20, p));
            document.documentElement.style.setProperty('--sp', pct + '%');
        }
        function ensureDivider() {
            if (divider) return;
            divider = document.createElement('div');
            divider.className = 'skpdf-divider';
            divider.innerHTML = '<button class="skpdf-swap" title="Swap the two PDFs" aria-label="Swap PDFs">' + ICON_SWAP + '</button>';
            document.body.appendChild(divider);
            divider.querySelector('.skpdf-swap').addEventListener('click', (e) => { e.stopPropagation(); swap(); });
            divider.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.skpdf-swap')) return;
                e.preventDefault();
                divider.setPointerCapture(e.pointerId);
                document.body.classList.add('skpdf-dragging');
                const mv = (ev) => {
                    const v = vertical();
                    setPct((v ? ev.clientY / window.innerHeight : ev.clientX / window.innerWidth) * 100);
                };
                const up = () => {
                    divider.removeEventListener('pointermove', mv);
                    divider.removeEventListener('pointerup', up);
                    divider.removeEventListener('pointercancel', up);
                    document.body.classList.remove('skpdf-dragging');
                    try { localStorage.setItem(LS_SPLIT, String(pct)); } catch (er) {}
                    refitAll();
                };
                divider.addEventListener('pointermove', mv);
                divider.addEventListener('pointerup', up);
                divider.addEventListener('pointercancel', up);
            });
        }
        function refitAll() { setTimeout(() => { A && A.refit(); B && B.refit(); }, 30); }
        function layout() {
            const l = left.el(), r = right.el();
            [l, r].forEach(x => x.classList.add('skpdf-split'));
            l.classList.add('pane-a'); l.classList.remove('pane-b');
            r.classList.add('pane-b'); r.classList.remove('pane-a');
            left.setTitleBtn(true); right.setTitleBtn(true);
            ensureDivider();
            setPct(pct);
            divider.classList.add('show');
            markActive();
            refitAll();
        }
        function markActive() {
            if (!on) return;
            [left, right].forEach(v => v && v.el().classList.toggle('active', v === activeViewer));
        }
        function enter(l, r) {
            left = l; right = r; on = true; layout();
        }
        function exit(keep) {
            on = false;
            [A, B].forEach(v => {
                if (!v) return;
                const el = v.el();
                el.classList.remove('skpdf-split', 'pane-a', 'pane-b', 'active');
                v.setTitleBtn(false);
            });
            if (divider) divider.classList.remove('show');
            left = right = null;
            refitAll();
        }
        function swap() {
            if (!on) return;
            const t = left; left = right; right = t;
            layout();
        }
        function ensureViewers() {
            if (!A) A = viewers[0] || createViewer();
            if (!B) B = createViewer();
        }
        function onClosed(v) {
            if (!on) return;
            if (v === left || v === right) exit();
        }
        // opts for the new PDF; `into` = pane to replace (optional)
        async function beside(opts, into) {
            ensureViewers();
            if (on) {
                const target = into || (activeViewer === left ? right : left);
                activeViewer = target;
                return target.open(opts);
            }
            const first = A.isOpen() ? A : (B.isOpen() ? B : null);
            const other = first === A ? B : A;
            if (!first) return A.open(opts);
            enter(first, other);
            activeViewer = other;
            return other.open(opts);
        }
        async function two(o1, o2) {
            ensureViewers();
            if (on) exit();
            A.open(o1); // not awaited: both panes load in parallel
            enter(A, B);
            activeViewer = A;
            return Promise.all([Promise.resolve(), B.open(o2)]);
        }
        function pick(v) {
            const hook = SK.onPickSecond;
            const done = (opts) => { if (!opts) return; on ? beside(opts, v) : beside(opts); };
            if (typeof hook === 'function') { hook(done, { excludeId: (v.info() || {}).id }); return; }
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'application/pdf,.pdf';
            inp.onchange = () => {
                const f = inp.files && inp.files[0]; if (!f) return;
                const url = URL.createObjectURL(f);
                done({ id: 'local:' + f.name + ':' + f.size, name: f.name, url, downloadUrl: url });
            };
            inp.click();
        }
        window.addEventListener('resize', () => { if (on) setPct(pct); });
        return { beside, two, pick, onClosed, markActive, isOn: () => on, swap };
    })();

    const SK = window.SKPdfViewer = {
        open(opts) {
            const first = viewers[0] || createViewer();
            // opening a normal single PDF ends any split view
            viewers.forEach(v => { if (v !== first && v.isOpen()) v.close(); });
            return first.open(opts);
        },
        openBeside: (opts) => Split.beside(opts),
        openSplit: (a, b) => Split.two(a, b),
        close() { viewers.slice().forEach(v => v.close()); },
        isOpen: () => viewers.some(v => v.isOpen()),
        isSplit: () => Split.isOn(),
        onPickSecond: null,
        _buildAnnotatedPdf: (...a) => (viewers[0] || createViewer())._buildAnnotatedPdf(...a)
    };
})();