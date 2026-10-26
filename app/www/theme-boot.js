/* Pick the visual tier and theme before first paint, so a low-end phone never
   paints the heavy version first. ui.js owns the rest. Loaded from <head>. */
(function(){try{var d=document.documentElement,s=localStorage,t=s.getItem("gh.ui.theme"),f=s.getItem("gh.ui.fx"),n=navigator,
lite=f==="lite"||(f!=="full"&&((n.deviceMemory&&n.deviceMemory<=3)||(n.hardwareConcurrency&&n.hardwareConcurrency<=4)));
if(t==="light"||t==="dark")d.setAttribute("data-theme",t);if(lite)d.classList.add("fx-lite");}catch(e){}})();
