const fs = require('fs');
const path = require('path');

const LOOT_PATH = path.join(__dirname, '..', 'shared', 'loot.json');

let catalog = JSON.parse(fs.readFileSync(LOOT_PATH, 'utf8'));
let keys = rebuildKeys(catalog);

function rebuildKeys(cat) {
  return new Set(cat.categories.flatMap((c) => c.items.map((i) => i.key)));
}

function save() {
  fs.writeFileSync(LOOT_PATH, JSON.stringify(catalog, null, 2) + '\n');
  keys = rebuildKeys(catalog);
}

function slugify(category, name) {
  const prefix = category.replace(/\s+/g, '_').toLowerCase();
  const suffix = name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_').toLowerCase();
  return `${prefix}__${suffix}`;
}

module.exports = {
  get catalog() { return catalog; },
  get keys() { return keys; },
  get priorities() { return new Set(catalog.priorities); },

  addCategory(label) {
    const key = label.replace(/\s+/g, '_').toLowerCase();
    if (catalog.categories.some((c) => c.key === key)) return null;
    const cat = { key, label, items: [] };
    catalog.categories.push(cat);
    save();
    return cat;
  },

  renameCategory(catKey, newLabel) {
    const cat = catalog.categories.find((c) => c.key === catKey);
    if (!cat) return false;
    cat.label = newLabel;
    save();
    return true;
  },

  deleteCategory(catKey) {
    const idx = catalog.categories.findIndex((c) => c.key === catKey);
    if (idx === -1) return false;
    catalog.categories.splice(idx, 1);
    save();
    return true;
  },

  addItem(catKey, name) {
    const cat = catalog.categories.find((c) => c.key === catKey);
    if (!cat) return null;
    const itemKey = slugify(catKey, name);
    if (cat.items.some((i) => i.key === itemKey)) return null;
    const item = { key: itemKey, name };
    cat.items.push(item);
    save();
    return item;
  },

  editItem(itemKey, newName) {
    for (const cat of catalog.categories) {
      const item = cat.items.find((i) => i.key === itemKey);
      if (item) {
        item.name = newName;
        save();
        return true;
      }
    }
    return false;
  },

  deleteItem(itemKey) {
    for (const cat of catalog.categories) {
      const idx = cat.items.findIndex((i) => i.key === itemKey);
      if (idx !== -1) {
        cat.items.splice(idx, 1);
        save();
        return true;
      }
    }
    return false;
  },
};
