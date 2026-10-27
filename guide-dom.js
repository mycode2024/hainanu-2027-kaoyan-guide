(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.HnuGuideDom = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function showSessionStorageWarning(root = document) {
    const warning = root.querySelector('#storage-session-warning');
    if (warning) warning.hidden = false;
  }

  function createTextElement(tagName, className, content) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  return {
    createTextElement,
    showSessionStorageWarning
  };
});
