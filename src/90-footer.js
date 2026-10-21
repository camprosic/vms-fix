  W.D0007 = Object.assign({ open, close, render, state, version: '0.1.3' }, D);

  // Floating launcher button. Skip it inside iframes (the portal loads entity
  // forms in modals and the script would run there too). Styles go in first -
  // v0.1.1 only added them when the console opened, which left this button
  // unstyled at the bottom of the page. Thanks, Safari, for making me notice.
  if (window.top === window.self && document.body) {
    addStyles();
    const b = el('button', { id: 'd0007-launch', type: 'button', title: APP_TITLE }, 'VMS');
    b.addEventListener('click', open);
    document.body.appendChild(b);
    if (location.hash === '#d0007') open();
  }
  // Second way in, from the Tampermonkey icon menu, in case the button is ever
  // hidden by something on the page.
  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand("Open Cam's VMS Console", open); } catch (e) { }
  }
})();
