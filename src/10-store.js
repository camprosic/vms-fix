  // --- local store ------------------------------------------------------
  // Unit-side info that VMS has no fields for: meet times, kits, vehicles,
  // coordinator, row colours, who's Command/Driver/Sr, etc. Lives in
  // localStorage on this browser only. Export/import moves it between people.
  const Store = (() => {
    const KEY = 'camsvms.v1';
    const SECTIONS = ['schedule', 'members', 'settings'];
    let data = null;
    function load() {
      if (data) return data;
      try { data = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { data = {}; }
      if (!data || typeof data !== 'object') data = {};
      SECTIONS.forEach(k => { if (!data[k] || typeof data[k] !== 'object') data[k] = {}; });
      return data;
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(load())); } catch (e) { /* private mode, quota, whatever - keep going in memory */ } }
    const get = (section, key) => load()[section][key];
    const set = (section, key, value) => {
      const d = load();
      if (value === undefined || value === null) delete d[section][key]; else d[section][key] = value;
      save();
    };
    // merge a partial object into an entry (handy for one-field edits)
    const patch = (section, key, partial) => set(section, key, { ...(get(section, key) || {}), ...partial });
    const all = section => ({ ...load()[section] });
    const exportJSON = () => JSON.stringify({ exported: new Date().toISOString(), ...load() }, null, 2);
    const importJSON = (text, { merge = true } = {}) => {
      const inc = JSON.parse(text); const d = load();
      SECTIONS.forEach(k => { const src = inc[k] && typeof inc[k] === 'object' ? inc[k] : {}; d[k] = merge ? { ...d[k], ...src } : { ...src }; });
      save();
    };
    const reset = () => { data = {}; SECTIONS.forEach(k => data[k] = {}); save(); };
    return { get, set, patch, all, exportJSON, importJSON, reset, KEY };
  })();
  D.Store = Store;
