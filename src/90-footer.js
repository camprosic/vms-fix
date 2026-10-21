  W.D0007 = Object.assign({ open, close, render, state, version: '0.1.3' }, D);

  // Floating launcher button. Skip it inside iframes (the portal loads its
  // entity forms in modal iframes and the script would run in there too).
  // Styles go in first - 0.1.1 only added them when the console opened, so on
  // Safari the button was a plain grey <button> at the very bottom of the page
  // and I spent twenty minutes thinking Teampermonkey wasnt running at all.
  if (window.top === window.self && document.body) {
    addStyles();
    const b = el('button', { id: 'd0007-launch', type: 'button', title: APP_TITLE }, 'VMS');
    b.addEventListener('click', open);
    document.body.appendChild(b);
    if (location.hash === '#d0007') open();
  }
  // Second way in, from the Tampermonkey icon menu, for when the button is
  // hidden behind something or I've broken the css again.
  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand("Open Cam's VMS Console", open); } catch (e) { }
  }
})();
