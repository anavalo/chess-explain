// The panel belongs to lichess tabs only: off by default, switched on per lichess tab. Chrome keeps a
// tab's panel when you switch away and hides it there, so other tabs never show it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.sidePanel.setOptions({ enabled: false });

const LICHESS = 'https://lichess.org/';
// tab.url is undefined outside lichess: the host permission covers lichess only
const sync = (tabId, url) => url?.startsWith(LICHESS)
  ? chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: true })
  : chrome.sidePanel.setOptions({ tabId, enabled: false });

chrome.tabs.onUpdated.addListener((tabId, _, tab) => sync(tabId, tab.url));
// lichess tabs that were open before the extension was installed or the browser restarted
chrome.tabs.query({ url: `${LICHESS}*` }).then(tabs => tabs.forEach(t => sync(t.id, t.url)));
