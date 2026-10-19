'use strict';

try {
  document.documentElement.setAttribute('data-mh-ext-cs', '1');
  window.__MH_EXT_CS__ = true;
  const marker = document.createElement('div');
  marker.id = 'mh-ext-cs-marker';
  marker.textContent = 'mh-ext-cs-ok';
  marker.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  (document.body || document.documentElement).appendChild(marker);
} catch (err) {
  console.warn('mh-ext content script', err);
}
