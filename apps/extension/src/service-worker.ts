export {}

const notificationRoutePrefix = 'df:notification-route:'

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.notifications.onClicked.addListener((notificationId) => {
  void (async () => {
    const key = `${notificationRoutePrefix}${notificationId}`
    const stored = await chrome.storage.local.get(key)
    const route = typeof stored[key] === 'string' && stored[key].startsWith('/') ? stored[key] : '/'
    await chrome.tabs.create({ url: chrome.runtime.getURL(`index.html#${route}`) })
    await chrome.storage.local.remove(key)
    await chrome.notifications.clear(notificationId)
  })()
})
