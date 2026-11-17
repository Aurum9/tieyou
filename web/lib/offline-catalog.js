export function createOfflineCatalogStorage() {
  let database;
  function open() {
    if (!database) {
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open('tieyou-offline-catalog', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(error => { database = undefined; throw error; });
    }
    return database;
  }

  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode);
      const values = work(tx.objectStore('records'));
      tx.oncomplete = () => resolve(values.map(request => request.result));
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    read: keys => transaction('readonly', store => keys.map(key => store.get(key))),
    write: entries => transaction('readwrite', store => entries.map(([key, value]) => store.put(value, key))),
  };
}
