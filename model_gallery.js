(function () {
  const ACTION_ID = 'model_gallery_open';
  const fs = require('fs');
  const path = require('path');
  let button = null;
  let selectedFolder = null;
  let galleryDialog = null;
  let cachedGalleryItems = [];
  let galleryFolderHistory = [];
  let activeGeneration = null;

  const mgDialogSuppress = {
    enabled: false,
    captured: []
  };

  const recentHistoryGuard = {
    enabled: false,
    depth: 0,
    snapshot: [],
    patches: []
  };

  function beginRecentHistoryGuard() {
    if (recentHistoryGuard.enabled) {
      recentHistoryGuard.depth += 1;
      return;
    }
    recentHistoryGuard.enabled = true;
    recentHistoryGuard.depth = 1;
    recentHistoryGuard.snapshot = snapshotRecentHistory();
    recentHistoryGuard.patches = installRecentHistoryWriteGuards();
  }

  function endRecentHistoryGuard() {
    if (!recentHistoryGuard.enabled) {
      return;
    }
    recentHistoryGuard.depth -= 1;
    if (recentHistoryGuard.depth > 0) {
      return;
    }
    restoreRecentHistory(recentHistoryGuard.snapshot);
    restoreRecentHistoryWriteGuards(recentHistoryGuard.patches);
    recentHistoryGuard.enabled = false;
    recentHistoryGuard.depth = 0;
    recentHistoryGuard.snapshot = [];
    recentHistoryGuard.patches = [];
  }

  function getRecentHistoryTargets() {
    const targets = [];
    const owners = [
      typeof App !== 'undefined' ? App : null,
      typeof Blockbench !== 'undefined' ? Blockbench : null,
      typeof Project !== 'undefined' ? Project : null,
      typeof FileSystem !== 'undefined' ? FileSystem : null
    ];

    const addTarget = (owner, propertyName) => {
      if (!owner || typeof owner !== 'object') return;
      if (propertyName in owner) {
        targets.push({ owner, propertyName });
      }
    };

    for (const owner of owners) {
      if (!owner) continue;
      const propertyNames = ['recent_files', 'recentFiles', 'recent_paths', 'recentPaths', 'recent_projects', 'recentProjects', 'recently_opened', 'recentlyOpened', 'opened_files', 'openedFiles'];
      for (const propertyName of propertyNames) {
        addTarget(owner, propertyName);
      }
    }

    return targets;
  }

  function snapshotRecentHistory() {
    const snapshot = [];
    for (const target of getRecentHistoryTargets()) {
      try {
        const current = target.owner[target.propertyName];
        if (Array.isArray(current)) {
          snapshot.push({ owner: target.owner, propertyName: target.propertyName, value: current.slice() });
        }
      } catch (error) {
        console.warn('[model_gallery] snapshotRecentHistory failed', target, error);
      }
    }
    for (const target of getStorageTargets()) {
      snapshot.push(...snapshotRecentStorage(target.storage, target.name));
    }
    return snapshot;
  }

  function restoreRecentHistory(snapshot) {
    const entries = Array.isArray(snapshot) ? snapshot : [];
    const storageTargets = new Map(getStorageTargets().map(target => [target.name, target.storage]));
    for (const entry of entries) {
      try {
        if (entry && entry.kind === 'storage') {
          const storage = storageTargets.get(entry.storageName);
          if (!storage) {
            continue;
          }
          if (entry.value === null || typeof entry.value === 'undefined') {
            if (typeof storage.removeItem === 'function') {
              storage.removeItem(entry.key);
            } else {
              delete storage[entry.key];
            }
          } else if (typeof storage.setItem === 'function') {
            storage.setItem(entry.key, entry.value);
          } else {
            storage[entry.key] = entry.value;
          }
        } else if (entry && entry.owner && typeof entry.owner === 'object') {
          entry.owner[entry.propertyName] = Array.isArray(entry.value) ? entry.value.slice() : entry.value;
        }
      } catch (error) {
        console.warn('[model_gallery] restoreRecentHistory failed', entry, error);
      }
    }
  }

  function purgeRecentProjects(filePaths) {
    const targetPaths = new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .filter(Boolean)
        .map(value => path.resolve(String(value)).toLowerCase())
    );

    if (!targetPaths.size) {
      return;
    }

    const lists = [];
    if (typeof recent_projects !== 'undefined' && recent_projects) {
      lists.push(recent_projects);
    }
    if (typeof Blockbench !== 'undefined' && Blockbench && Blockbench.recent_projects) {
      lists.push(Blockbench.recent_projects);
    }

    for (const list of lists) {
      try {
        const items = Array.isArray(list) ? list.slice() : [];
        for (const item of items) {
          const itemPath = String(item && (item.path || item.filePath || item.name || '')).trim();
          if (!itemPath) {
            continue;
          }

          const normalized = path.resolve(itemPath).toLowerCase();
          if (!targetPaths.has(normalized)) {
            continue;
          }

          if (typeof list.remove === 'function') {
            list.remove(item);
          } else if (Array.isArray(list)) {
            const index = list.indexOf(item);
            if (index !== -1) {
              list.splice(index, 1);
            }
          }
        }
      } catch (error) {
        console.warn('[model_gallery] purgeRecentProjects failed', error);
      }
    }

    try {
      if (typeof updateRecentProjects === 'function') {
        updateRecentProjects();
      }
    } catch (error) {
      console.warn('[model_gallery] updateRecentProjects failed', error);
    }

    try {
      if (typeof StateMemory !== 'undefined' && StateMemory && typeof StateMemory.save === 'function') {
        StateMemory.save('recent_projects');
      }
    } catch (error) {
      console.warn('[model_gallery] StateMemory.save(recent_projects) failed', error);
    }
  }

  function isRecentHistoryKey(key) {
    const text = String(key || '').toLowerCase();
    return text.includes('recent') || text.includes('history') || text.includes('opened') || text.includes('open');
  }

  function getStorageTargets() {
    const targets = [];
    if (typeof localStorage !== 'undefined' && localStorage) {
      targets.push({ name: 'localStorage', storage: localStorage });
    }
    if (typeof sessionStorage !== 'undefined' && sessionStorage) {
      targets.push({ name: 'sessionStorage', storage: sessionStorage });
    }
    return targets;
  }

  function snapshotRecentStorage(storage, storageName) {
    const snapshot = [];
    if (!storage || typeof storage.key !== 'function') {
      return snapshot;
    }

    let length = 0;
    try {
      length = Number(storage.length) || 0;
    } catch (error) {
      return snapshot;
    }

    for (let index = 0; index < length; index++) {
      try {
        const key = storage.key(index);
        if (!isRecentHistoryKey(key)) {
          continue;
        }
        snapshot.push({
          kind: 'storage',
          storageName,
          key: String(key),
          value: typeof storage.getItem === 'function' ? storage.getItem(key) : storage[key]
        });
      } catch (error) {
        console.warn('[model_gallery] snapshotRecentStorage failed', storageName, index, error);
      }
    }

    return snapshot;
  }

  function installRecentHistoryWriteGuards() {
    const patches = [];

      const patchMethod = (target, key, replacement) => {
        if (!target || typeof target !== 'object') {
          return;
        }

        let source = target;
        let descriptor = null;
        while (source && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(source, key);
          if (!descriptor) {
            source = Object.getPrototypeOf(source);
          }
        }

        if (!descriptor || typeof descriptor.value !== 'function') {
          return;
        }

        const hadOwnDescriptor = Object.prototype.hasOwnProperty.call(target, key);
        try {
          Object.defineProperty(target, key, {
            configurable: true,
            writable: true,
            value: replacement(descriptor.value)
          });
          patches.push({ target, key, descriptor: hadOwnDescriptor ? descriptor : null });
        } catch (error) {
          console.warn('[model_gallery] patchMethod failed', key, error);
        }
    };

    const patchArrayMutators = (array) => {
      if (!Array.isArray(array)) {
        return;
      }

      const mutators = ['push', 'unshift', 'splice', 'shift', 'pop', 'sort', 'reverse'];
      for (const key of mutators) {
        patchMethod(array, key, (original) => function () {
          if (recentHistoryGuard.enabled) {
            return key === 'push' || key === 'unshift' ? array.length : [];
          }
          return original.apply(this, arguments);
        });
      }
    };

    const patchOwnerMethods = (owner) => {
      if (!owner || typeof owner !== 'object') {
        return;
      }

      const methodNames = [
        'addRecent', 'addRecentFile', 'addRecentProject',
        'trackOpenFile', 'trackOpenProject', 'trackRecentFile', 'trackRecentProject',
        'pushRecentFile', 'pushRecentProject', 'setRecentFile', 'setRecentProject',
        'recordRecentFile', 'recordRecentProject', 'recordOpenFile', 'recordOpenProject'
      ];

      for (const key of methodNames) {
        patchMethod(owner, key, (original) => function () {
          if (recentHistoryGuard.enabled) {
            return undefined;
          }
          return original.apply(this, arguments);
        });
      }
    };

      const storage = typeof localStorage !== 'undefined' ? localStorage : null;
      if (storage) {
        for (const key of ['setItem', 'removeItem']) {
          patchMethod(storage, key, (original) => function (storageKey) {
            if (recentHistoryGuard.enabled && isRecentHistoryKey(storageKey)) {
              return undefined;
            }
            return original.apply(this, arguments);
          });
        }
      }

      const storagePrototype = typeof Storage !== 'undefined' && Storage && Storage.prototype ? Storage.prototype : null;
      if (storagePrototype) {
        for (const key of ['setItem', 'removeItem', 'clear']) {
          patchMethod(storagePrototype, key, (original) => function () {
            if (recentHistoryGuard.enabled) {
              if (key === 'clear') {
                return undefined;
              }
              const storageKey = arguments.length ? arguments[0] : null;
              if (isRecentHistoryKey(storageKey)) {
                return undefined;
              }
            }
            return original.apply(this, arguments);
          });
        }
      }

      for (const target of getRecentHistoryTargets()) {
        patchArrayMutators(target.owner[target.propertyName]);
      }

      patchOwnerMethods(typeof App !== 'undefined' ? App : null);
      patchOwnerMethods(typeof Blockbench !== 'undefined' ? Blockbench : null);
      patchOwnerMethods(typeof Project !== 'undefined' ? Project : null);
      patchOwnerMethods(typeof FileSystem !== 'undefined' ? FileSystem : null);

    return patches;
  }

  async function waitForRecentHistorySettle() {
    await new Promise(resolve => setTimeout(resolve, 120));
  }

  function restoreRecentHistoryWriteGuards(patches) {
    for (let index = patches.length - 1; index >= 0; index--) {
      const patch = patches[index];
      try {
        if (patch && patch.target) {
          if (patch.descriptor) {
            Object.defineProperty(patch.target, patch.key, patch.descriptor);
          } else {
            delete patch.target[patch.key];
          }
        }
      } catch (error) {
        console.warn('[model_gallery] restoreRecentHistoryWriteGuards failed', patch && patch.key, error);
      }
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showMessage(message) {
    try {
      if (typeof SnackBar !== 'undefined' && SnackBar && typeof SnackBar.show === 'function') {
        SnackBar.show(message);
      } else if (typeof Blockbench !== 'undefined' && Blockbench && typeof Blockbench.showMessage === 'function') {
        Blockbench.showMessage(message);
      } else if (typeof alert === 'function') {
        alert(message);
      }
    } catch (error) {
      console.warn('[model_gallery] showMessage failed', error);
    }
  }

  function getCodecExtensions() {
    const extensions = new Set();

    if (typeof Codecs !== 'undefined' && Codecs) {
      for (const codec of Object.values(Codecs)) {
        if (!codec || typeof codec !== 'object') {
          continue;
        }

        const candidates = [];
        if (typeof codec.extension === 'string' && codec.extension.trim()) {
          candidates.push(codec.extension.trim());
        }
        if (Array.isArray(codec.extensions)) {
          for (const item of codec.extensions) {
            if (typeof item === 'string' && item.trim()) {
              candidates.push(item.trim());
            }
          }
        }
        if (typeof codec.file_extension === 'string' && codec.file_extension.trim()) {
          candidates.push(codec.file_extension.trim());
        }
        if (codec.format && typeof codec.format.file_extension === 'string' && codec.format.file_extension.trim()) {
          candidates.push(codec.format.file_extension.trim());
        }

        for (const candidate of candidates) {
          const normalized = String(candidate).startsWith('.') ? String(candidate).toLowerCase() : `.${String(candidate).toLowerCase()}`;
          if (normalized && normalized.length > 1) {
            extensions.add(normalized);
          }
        }
      }
    }

    const coreFallbacks = ['.jem', '.json', '.bbmodel', '.obj', '.gltf', '.glb', '.dae', '.fbx', '.mqo', '.stl'];
    for (const ext of coreFallbacks) {
      extensions.add(ext);
    }
    extensions.delete('.png');
    extensions.delete('.jpg');
    extensions.delete('.jpeg');
    extensions.delete('.bmp');
    extensions.delete('.webp');

    return [...extensions].sort((a, b) => a.localeCompare(b));
  }

  function isLikelyBlockbenchModelJson(filePath) {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      if (!text || !text.trim()) {
        return false;
      }

      const trimmed = text.trim();
      if (!trimmed.startsWith('{')) {
        return false;
      }

      const data = JSON.parse(trimmed);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
      }

      const keys = Object.keys(data);
      if (!keys.length) {
        return false;
      }

      const isBlockstateLike = Object.prototype.hasOwnProperty.call(data, 'variants') || Object.prototype.hasOwnProperty.call(data, 'multipart');
      if (isBlockstateLike) {
        return false;
      }

      const hasDirectModelShape = !!(
        Array.isArray(data.elements) ||
        typeof data.textures === 'object' ||
        typeof data.display === 'object' ||
        typeof data.parent === 'string' ||
        typeof data.gui_light === 'string' ||
        typeof data.ambientocclusion === 'boolean' ||
        Array.isArray(data.overrides)
      );

      if (hasDirectModelShape) {
        return true;
      }

      const lowerPath = String(filePath).toLowerCase();
      const isInModelsFolder = lowerPath.includes(`${path.sep}models${path.sep}`) || lowerPath.includes('/models/') || lowerPath.includes('\\models\\');
      const isBlockstatePath = lowerPath.includes(`${path.sep}blockstates${path.sep}`) || lowerPath.includes('/blockstates/') || lowerPath.includes('\\blockstates\\');
      return !isBlockstatePath && isInModelsFolder;
    } catch (error) {
      return false;
    }
  }

  function shouldIncludeFile(entryPath, ext) {
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.bmp' || ext === '.webp') {
      return false;
    }

    if (ext !== '.json') {
      return true;
    }

    const lowerPath = String(entryPath).toLowerCase();
    const isBlockstatePath = lowerPath.includes(`${path.sep}blockstates${path.sep}`) || lowerPath.includes('/blockstates/') || lowerPath.includes('\\blockstates\\');
    const isModelJson = isLikelyBlockbenchModelJson(entryPath);
    return !isBlockstatePath && isModelJson;
  }

  function scanModelFiles(rootFolder) {
    const result = {
      modelFiles: [],
      errors: []
    };

    if (!rootFolder || !fs.existsSync(rootFolder)) {
      result.errors.push('選択されたフォルダが存在しません。');
      return result;
    }

    const supportedExtensions = new Set(getCodecExtensions());
    const stack = [rootFolder];

    while (stack.length) {
      const current = stack.pop();

      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (error) {
        result.errors.push(current + ': ' + (error && error.message ? error.message : String(error)));
        continue;
      }

      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();

        if (!supportedExtensions.has(ext)) {
          continue;
        }

        if (!shouldIncludeFile(entryPath, ext)) {
          continue;
        }

        result.modelFiles.push(entryPath);
      }
    }

    result.modelFiles.sort((a, b) => a.localeCompare(b));
    return result;
  }

  async function selectResourcePackFolder() {
    try {
      beginRecentHistoryGuard();
      if (typeof Filesystem !== 'undefined' && Filesystem && typeof Filesystem.pickDirectory === 'function') {
        const folder = Filesystem.pickDirectory({
          title: 'Select resource pack folder'
        });
        await waitForRecentHistorySettle();
        return folder;
      }

      showMessage('Blockbench の Filesystem.pickDirectory API が利用できません。');
      return null;
    } catch (error) {
      console.warn('[model_gallery] selectResourcePackFolder failed', error);
      showMessage('フォルダ選択に失敗しました。');
      return null;
    } finally {
      endRecentHistoryGuard();
    }
  }

  function getCodecForFile(filePath) {
    const lower = String(filePath).toLowerCase();
    const ext = path.extname(lower).replace(/^\./, '');

    if (typeof Codecs !== 'undefined' && Codecs) {
      const registry = Object.values(Codecs);
      for (const codec of registry) {
        if (!codec || typeof codec !== 'object') {
          continue;
        }

        const candidates = [];
        if (typeof codec.extension === 'string' && codec.extension.trim()) {
          candidates.push(codec.extension.trim().toLowerCase());
        }
        if (Array.isArray(codec.extensions)) {
          for (const value of codec.extensions) {
            if (typeof value === 'string' && value.trim()) {
              candidates.push(value.trim().toLowerCase());
            }
          }
        }
        if (typeof codec.file_extension === 'string' && codec.file_extension.trim()) {
          candidates.push(codec.file_extension.trim().toLowerCase());
        }
        if (codec.format && typeof codec.format.file_extension === 'string' && codec.format.file_extension.trim()) {
          candidates.push(codec.format.file_extension.trim().toLowerCase());
        }

        if (candidates.includes(ext)) {
          return codec;
        }
      }
    }

    if (lower.endsWith('.jem') && typeof Codecs !== 'undefined' && Codecs && Codecs.jem) {
      return Codecs.jem;
    }

    if (lower.endsWith('.json') && typeof Codecs !== 'undefined' && Codecs && Codecs.java_block) {
      return Codecs.java_block;
    }

    if (typeof Codecs !== 'undefined' && Codecs) {
      return Object.values(Codecs).find(codec => codec && (
        (codec.extension && codec.extension.toLowerCase() === ext) ||
        (Array.isArray(codec.extensions) && codec.extensions.some(item => String(item).toLowerCase() === ext)) ||
        (codec.name && /jem|java block|java_block/i.test(codec.name))
      )) || null;
    }

    return null;
  }

  function openModelInEditor(filePath) {
    const codec = getCodecForFile(filePath);
    if (!codec) {
      showMessage('このモデル形式に対応する codec が見つかりません。');
      return;
    }

    try {
      const file = {
        name: path.basename(filePath),
        path: filePath,
        content: fs.readFileSync(filePath, 'utf8')
      };

      if (typeof loadModelFile === 'function') {
        loadModelFile(file, { import_to_current_project: false });
        return;
      }

      if (codec && typeof codec.load === 'function') {
        codec.load({}, file, { import_to_current_project: false });
        return;
      }
    } catch (error) {
      console.warn('[model_gallery] openModelInEditor failed', error);
    }

    showMessage('モデルを Blockbench で開けませんでした。');
  }

  async function closeTempPreviewProjects(baseProject) {
    const candidates = [];

    if (typeof Project !== 'undefined' && Project && (!baseProject || Project !== baseProject)) {
      candidates.push(Project);
    }

    if (typeof ModelProject !== 'undefined' && Array.isArray(ModelProject.all)) {
      for (const project of ModelProject.all) {
        if (project && (!baseProject || project !== baseProject) && !candidates.includes(project)) {
          candidates.push(project);
        }
      }
    }

    for (const project of candidates) {
      try {
        if (project && typeof project.close === 'function') {
          await project.close(true);
        }
      } catch (error) {
        console.warn('[model_gallery] closeTempPreviewProjects failed', project && project.name, error);
      }
    }

    if (baseProject && typeof baseProject.select === 'function') {
      baseProject.select();
    } else if (typeof selectNoProject === 'function') {
      selectNoProject();
    }
  }

  async function captureModelThumbnail(filePath, sourceFolder) {
    const fileName = path.basename(filePath);
    const codec = getCodecForFile(filePath);

    try {
      mgDialogSuppress.enabled = true;
      mgDialogSuppress.captured = [];

      const baseProject = typeof Project !== 'undefined' ? Project : null;
      const formatName = codec && codec.format ? (codec.format.id || codec.format) : (filePath.toLowerCase().endsWith('.jem') ? 'optifine_jem' : 'java_block');

      const modelFile = {
        name: fileName,
        path: filePath,
        content: fs.readFileSync(filePath, 'utf8')
      };

      let loaded = false;
      if (typeof loadModelFile === 'function') {
        try {
          loadModelFile(modelFile, { import_to_current_project: false });
          loaded = true;
        } catch (error) {
          console.warn('[model_gallery] loadModelFile direct open failed, falling back to blank project setup', error);
        }
      }

      if (!loaded && codec && typeof codec.load === 'function') {
        try {
          codec.load({}, modelFile, { import_to_current_project: false });
          loaded = true;
        } catch (error) {
          console.warn('[model_gallery] codec.load direct open failed, falling back to blank project setup', error);
        }
      }

      if (!loaded) {
        if (typeof setupProject === 'function') {
          setupProject(formatName);
        } else if (typeof newProject === 'function') {
          newProject(formatName);
        } else {
          throw new Error('Project creation API is not available');
        }

        if (typeof loadModelFile === 'function') {
          loadModelFile(modelFile, { import_to_current_project: false });
          loaded = true;
        } else if (codec && typeof codec.load === 'function') {
          codec.load({}, modelFile, { import_to_current_project: false });
          loaded = true;
        }
      }

      if (!loaded) {
        throw new Error('No compatible model loader was found');
      }

      let dataUrl = '';
      let previewAttempts = 0;
      while (previewAttempts < 3 && !dataUrl) {
        previewAttempts += 1;
        const stabilizedPreviewUrl = await waitForMainPreviewReady();
        dataUrl = stabilizedPreviewUrl || '';

        if (typeof Screencam !== 'undefined' && Screencam && typeof Screencam.cleanCanvas === 'function') {
          await new Promise((resolve) => {
            Screencam.cleanCanvas({ width: 256, height: 256 }, (result) => {
              dataUrl = result || dataUrl || '';
              resolve();
            });
          });
        } else if (typeof Screencam !== 'undefined' && Screencam && typeof Screencam.screenshotPreview === 'function' && typeof main_preview !== 'undefined') {
          await new Promise((resolve) => {
            Screencam.screenshotPreview(main_preview, { width: 256, height: 256 }, (result) => {
              dataUrl = result || dataUrl || '';
              resolve();
            });
          });
        } else if (typeof main_preview !== 'undefined' && main_preview && main_preview.canvas && typeof main_preview.canvas.toDataURL === 'function') {
          dataUrl = dataUrl || main_preview.canvas.toDataURL('image/png');
        }

        if (!dataUrl && typeof main_preview !== 'undefined' && main_preview && main_preview.canvas && typeof main_preview.canvas.toDataURL === 'function') {
          dataUrl = main_preview.canvas.toDataURL('image/png');
        }

        if (!dataUrl && previewAttempts < 3) {
          await new Promise(resolve => setTimeout(resolve, 120));
        }
      }

      if (!dataUrl) {
        throw new Error('Preview canvas did not produce a usable screenshot');
      }

      try {
        for (const dlg of mgDialogSuppress.captured || []) {
          try {
            if (dlg && typeof dlg.hide === 'function') dlg.hide();
            else if (dlg && typeof dlg.close === 'function') dlg.close();
          } catch (e) {
          }
        }
      } catch (e) {
        console.warn('[model_gallery] closing suppressed dialogs failed', e);
      }

      mgDialogSuppress.enabled = false;
      mgDialogSuppress.captured = [];

      await closeTempPreviewProjects(baseProject);
      await waitForRecentHistorySettle();
      purgeRecentProjects([filePath]);

      return {
        filePath,
        fileName,
        dataUrl,
        sourceFolder: sourceFolder ? path.resolve(sourceFolder) : '',
        error: null
      };
    } catch (error) {
      console.warn('[model_gallery] captureModelThumbnail failed', filePath, error);
      try {
        for (const dlg of mgDialogSuppress.captured || []) {
          try { if (dlg && typeof dlg.hide === 'function') dlg.hide(); else if (dlg && typeof dlg.close === 'function') dlg.close(); } catch (e) {}
        }
      } catch (e) {}
      mgDialogSuppress.enabled = false;
      mgDialogSuppress.captured = [];
      await waitForRecentHistorySettle();
      purgeRecentProjects([filePath]);

      return {
        filePath,
        fileName,
        dataUrl: '',
        sourceFolder: sourceFolder ? path.resolve(sourceFolder) : '',
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  function makeGalleryToolbarMarkup() {
    return '<div class="mg-toolbar">' +
      '<label class="mg-search-wrap">' +
        '<span class="mg-search-icon" aria-hidden="true"><i class="material-icons">search</i></span>' +
        '<input type="text" class="mg-search" placeholder="Search files..." />' +
      '</label>' +
      '<button type="button" class="mg-action" data-action="add-folder">' +
        '<span class="mg-action-icon" aria-hidden="true">' +
          '<i class="material-icons">create_new_folder</i>' +
        '</span>' +
        '<span class="mg-action-label">Add Folder</span>' +
      '</button>' +
      '<button type="button" class="mg-action" data-action="refresh-folder">' +
        '<span class="mg-action-icon" aria-hidden="true">' +
          '<i class="material-icons">refresh</i>' +
        '</span>' +
        '<span class="mg-action-label">Refresh</span>' +
      '</button>' +
      '<button type="button" class="mg-action" data-action="export-gallery">' +
        '<span class="mg-action-icon" aria-hidden="true">' +
          '<i class="material-icons">download</i>' +
        '</span>' +
        '<span class="mg-action-label">Export</span>' +
      '</button>' +
      '<button type="button" class="mg-action" data-action="reset-gallery">' +
        '<span class="mg-action-icon" aria-hidden="true">' +
          '<i class="material-icons">delete_forever</i>' +
        '</span>' +
        '<span class="mg-action-label">Reset</span>' +
      '</button>' +
      '</div>';
  }

  function makeLoadedFoldersMarkup() {
    const folders = Array.from(new Set((galleryFolderHistory || []).map(folder => String(folder).trim()).filter(Boolean)));
    if (!folders.length) {
      return '';
    }

    const chips = folders.map(folder => {
      const safeFolder = escapeHtml(folder);
      return '<div class="mg-folder-row" data-folder="' + safeFolder + '">' +
        '<span class="mg-folder-chip" title="' + safeFolder + '">' + safeFolder + '</span>' +
        '<button type="button" class="mg-folder-action" data-action="open-folder" data-folder="' + safeFolder + '" title="Open in Explorer" aria-label="Open in Explorer">' +
          '<i class="material-icons">folder_open</i>' +
        '</button>' +
        '<button type="button" class="mg-folder-action" data-action="remove-folder" data-folder="' + safeFolder + '" title="Remove from Gallery" aria-label="Remove from Gallery">' +
          '<i class="material-icons">delete_forever</i>' +
        '</button>' +
        '</div>';
    }).join('');
    return '<div class="mg-folder-panel">' +
      '<div class="mg-folder-title">Loaded folders</div>' +
      '<div class="mg-folder-list">' + chips + '</div>' +
      '</div>';
  }

  function openFolderInExplorer(folderPath) {
    const target = String(folderPath || '').trim();
    if (!target) {
      return;
    }

    const resolvedTarget = path.resolve(target);

    try {
      if (typeof Filesystem !== 'undefined' && Filesystem && typeof Filesystem.showFileInFolder === 'function') {
        Filesystem.showFileInFolder(resolvedTarget);
        return;
      }
      if (typeof shell !== 'undefined' && shell && typeof shell.showItemInFolder === 'function') {
        shell.showItemInFolder(resolvedTarget);
        return;
      }
      if (typeof shell !== 'undefined' && shell && typeof shell.openPath === 'function') {
        const result = shell.openPath(resolvedTarget);
        if (result && typeof result.then === 'function') {
          result.catch(error => {
            console.warn('[model_gallery] shell.openPath failed', error);
          });
        }
        return;
      }
    } catch (error) {
      console.warn('[model_gallery] shell open failed', error);
    }

    try {
      if (typeof Blockbench !== 'undefined' && Blockbench && typeof Blockbench.showFileInFolder === 'function') {
        Blockbench.showFileInFolder(resolvedTarget);
        return;
      }
    } catch (error) {
      console.warn('[model_gallery] Blockbench.showFileInFolder failed', error);
    }

    console.warn('[model_gallery] openFolderInExplorer failed', resolvedTarget);
  }

  function removeFolderFromGallery(folderPath) {
    const target = String(folderPath || '').trim();
    if (!target) {
      return;
    }

    const normalizedTarget = normalizeGalleryPath(target);
    galleryFolderHistory = (galleryFolderHistory || []).filter(folder => normalizeGalleryPath(folder) !== normalizedTarget);
    cachedGalleryItems = (cachedGalleryItems || []).filter(item => {
      return !isGalleryItemFromFolder(item, target);
    });
    selectedFolder = galleryFolderHistory.length ? galleryFolderHistory[galleryFolderHistory.length - 1] : null;
    showGalleryDialog(cachedGalleryItems);
  }

  function normalizeGalleryPath(value) {
    return path.resolve(String(value || '')).toLowerCase();
  }

  function isPathInsideFolder(folderPath, filePath) {
    const folder = String(folderPath || '').trim();
    const file = String(filePath || '').trim();
    if (!folder || !file) {
      return false;
    }

    try {
      const relative = path.relative(path.resolve(folder), path.resolve(file));
      return !!relative && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch (error) {
      return false;
    }
  }

  function getGalleryItemSourceFolder(item) {
    if (!item) {
      return null;
    }

    const explicit = String(item.sourceFolder || '').trim();
    if (explicit) {
      return path.resolve(explicit);
    }

    const filePath = String(item.filePath || '').trim();
    if (!filePath) {
      return null;
    }

    const folders = Array.from(new Set((galleryFolderHistory || []).map(folder => String(folder).trim()).filter(Boolean)));
    let bestFolder = null;
    let bestLength = -1;
    for (const folder of folders) {
      if (!isPathInsideFolder(folder, filePath)) {
        continue;
      }
      const resolved = path.resolve(folder);
      if (resolved.length > bestLength) {
        bestFolder = resolved;
        bestLength = resolved.length;
      }
    }

    return bestFolder;
  }

  function isGalleryItemFromFolder(item, folderPath) {
    const target = String(folderPath || '').trim();
    const filePath = String(item && item.filePath ? item.filePath : '').trim();
    if (!target || !filePath) {
      return false;
    }

    const explicitFolder = getGalleryItemSourceFolder(item);
    if (explicitFolder && normalizeGalleryPath(explicitFolder) === normalizeGalleryPath(target)) {
      return true;
    }

    return isPathInsideFolder(target, filePath);
  }

  function getGalleryItemRelativePath(item, folderPath) {
    const filePath = String(item && item.filePath ? item.filePath : '').trim();
    if (!filePath) {
      return '';
    }

    const folder = String(folderPath || '').trim();
    if (!folder) {
      return String(item && item.fileName ? item.fileName : path.basename(filePath));
    }

    try {
      const relative = path.relative(path.resolve(folder), path.resolve(filePath));
      if (relative && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join('/');
      }
    } catch (error) {
      console.warn('[model_gallery] getGalleryItemRelativePath failed', error);
    }

    return String(item && item.fileName ? item.fileName : path.basename(filePath));
  }

  function groupGalleryItemsByFolder(items) {
    const grouped = new Map();
    const order = new Map();
    const historyFolders = Array.from(new Set((galleryFolderHistory || []).map(folder => String(folder).trim()).filter(Boolean)));
    historyFolders.forEach((folder, index) => {
      order.set(normalizeGalleryPath(folder), index);
    });

    for (const item of items || []) {
      if (!item || !item.filePath) {
        continue;
      }

      const folderPath = getGalleryItemSourceFolder(item) || '';
      const key = folderPath ? normalizeGalleryPath(folderPath) : '__unknown__';
      if (!grouped.has(key)) {
        grouped.set(key, {
          folderPath: folderPath ? path.resolve(folderPath) : '',
          items: []
        });
      }
      grouped.get(key).items.push(item);
    }

    const groups = Array.from(grouped.values());
    groups.sort((left, right) => {
      const leftOrder = left.folderPath ? (order.has(normalizeGalleryPath(left.folderPath)) ? order.get(normalizeGalleryPath(left.folderPath)) : Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const rightOrder = right.folderPath ? (order.has(normalizeGalleryPath(right.folderPath)) ? order.get(normalizeGalleryPath(right.folderPath)) : Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return String(left.folderPath || '').localeCompare(String(right.folderPath || ''));
    });

    for (const group of groups) {
      group.items.sort((a, b) => getGalleryItemRelativePath(a, group.folderPath).localeCompare(getGalleryItemRelativePath(b, group.folderPath)));
    }

    return groups;
  }

  function buildGalleryExportHtml(items) {
    const groups = groupGalleryItemsByFolder(items);
    const absoluteFolders = Array.from(new Set(groups.map(group => group.folderPath).filter(Boolean)));
    const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
    const exportedAt = new Date();
    const exportedAtText = exportedAt.toLocaleString('ja-JP');

    const folderSummary = absoluteFolders.length
      ? absoluteFolders.map(folder => '<div class="mg-export-folder-chip">' + escapeHtml(path.basename(folder)) + '</div>').join('')
      : '<div class="mg-export-empty">No loaded folders</div>';

    const groupMarkup = groups.length
      ? groups.map(group => {
          const title = group.folderPath ? path.basename(group.folderPath) : 'Unknown source folder';
          const safeTitle = escapeHtml(title);
          const cards = group.items.map(item => {
            const relativePath = escapeHtml(getGalleryItemRelativePath(item, group.folderPath));
            const fileName = escapeHtml(item.fileName || path.basename(item.filePath || ''));
            const imageMarkup = item.dataUrl
              ? '<img src="' + item.dataUrl + '" alt="' + fileName + '" />'
              : '<div class="mg-export-thumb-fallback">No Preview</div>';

            return '<article class="mg-export-card">' +
              '<div class="mg-export-thumb">' + imageMarkup + '</div>' +
              '<div class="mg-export-body">' +
                '<div class="mg-export-name">' + fileName + '</div>' +
                '<div class="mg-export-path" title="' + relativePath + '">' + relativePath + '</div>' +
              '</div>' +
            '</article>';
          }).join('');

          return '<section class="mg-export-group">' +
            '<div class="mg-export-group-head">' +
              '<div class="mg-export-group-title">' + safeTitle + '</div>' +
              '<div class="mg-export-group-count">' + group.items.length + ' item(s)</div>' +
            '</div>' +
            '<div class="mg-export-grid">' + cards + '</div>' +
          '</section>';
        }).join('')
      : '<section class="mg-export-empty-section">No gallery items available.</section>';

    return '<!doctype html>' +
      '<html lang="ja">' +
      '<head>' +
        '<meta charset="utf-8" />' +
        '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
        '<title>Model Gallery Export</title>' +
        '<style>' +
          ':root{color-scheme:dark;--bg:#0f1217;--panel:#171b22;--panel2:#1d232d;--border:#384150;--border2:#4d5a6e;--text:#e6edf6;--muted:#a5b2c3;--accent:#6fa8ff;--accent2:#8cf0c7;}' +
          '*{box-sizing:border-box;}' +
          'body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;}' +
          '.mg-export-page{max-width:1280px;margin:0 auto;padding:24px;}' +
          '.mg-export-header{padding:20px 20px 16px;background:linear-gradient(180deg,#1a1f28,#151922);border:1px solid var(--border);border-radius:12px;margin-bottom:16px;box-shadow:0 12px 34px rgba(0,0,0,.28);}' +
          '.mg-export-title{font-size:24px;font-weight:700;margin:0 0 6px;}' +
          '.mg-export-meta{display:flex;flex-wrap:wrap;gap:12px;color:var(--muted);font-size:13px;}' +
          '.mg-export-summary{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);}' +
          '.mg-export-summary-title{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#c5cfdd;margin-bottom:8px;}' +
          '.mg-export-folder-list{display:flex;flex-wrap:wrap;gap:8px;}' +
          '.mg-export-folder-chip{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:#11161d;color:var(--text);font-size:12px;word-break:break-all;}' +
          '.mg-export-empty{color:var(--muted);font-size:13px;}' +
          '.mg-export-group{margin-top:16px;padding:16px;background:var(--panel);border:1px solid var(--border);border-radius:12px;}' +
          '.mg-export-group-head{display:grid;grid-template-columns:1fr auto;gap:6px 12px;align-items:start;margin-bottom:14px;}' +
          '.mg-export-group-title{font-size:18px;font-weight:700;word-break:break-all;}' +
          '.mg-export-group-count{grid-column:2 / span 1;color:#d3deeb;font-size:12px;white-space:nowrap;align-self:center;}' +
          '.mg-export-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;}' +
          '.mg-export-card{background:var(--panel2);border:1px solid var(--border);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;min-height:100%;}' +
          '.mg-export-thumb{height:170px;background:#0c1015;padding:8px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid rgba(255,255,255,.06);}' +
          '.mg-export-thumb img{max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;display:block;}' +
          '.mg-export-thumb-fallback{font-size:12px;color:var(--muted);}' +
          '.mg-export-body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;}' +
          '.mg-export-name{font-size:13px;font-weight:600;word-break:break-word;}' +
          '.mg-export-path{font-size:12px;color:var(--muted);word-break:break-all;}' +
          '.mg-export-empty-section{padding:32px;border:1px dashed var(--border2);border-radius:12px;color:var(--muted);text-align:center;}' +
        '</style>' +
      '</head>' +
      '<body>' +
        '<main class="mg-export-page">' +
          '<header class="mg-export-header">' +
            '<h1 class="mg-export-title">Model Gallery Export</h1>' +
            '<div class="mg-export-meta">' +
              '<div>Exported: ' + escapeHtml(exportedAtText) + '</div>' +
              '<div>Total items: ' + totalItems + '</div>' +
              '<div>Folders: ' + groups.filter(group => group.folderPath).length + '</div>' +
            '</div>' +
            '<div class="mg-export-summary">' +
              '<div class="mg-export-summary-title">Loaded folders</div>' +
              '<div class="mg-export-folder-list">' + folderSummary + '</div>' +
            '</div>' +
          '</header>' +
          groupMarkup +
        '</main>' +
      '</body>' +
      '</html>';
  }

  async function waitForMainPreviewReady() {
    const preview = typeof main_preview !== 'undefined' ? main_preview : null;
    const canvas = preview && preview.canvas ? preview.canvas : null;
    if (!canvas || typeof canvas.toDataURL !== 'function') {
      await new Promise(resolve => setTimeout(resolve, 80));
      return '';
    }

    const timeoutAt = Date.now() + 5000;
    let lastSnapshot = '';
    let stableCount = 0;

    while (Date.now() < timeoutAt) {
      try {
        if (preview && typeof preview.render === 'function') {
          preview.render();
        }
      } catch (error) {
        console.warn('[model_gallery] preview.render failed', error);
      }

      if (canvas.width > 0 && canvas.height > 0) {
        const snapshot = canvas.toDataURL('image/png');
        if (snapshot && snapshot.length > 1000) {
          if (lastSnapshot && lastSnapshot === snapshot) {
            stableCount += 1;
            if (stableCount >= 2) {
              return snapshot;
            }
          } else {
            stableCount = 0;
          }
          lastSnapshot = snapshot;
        }
      }

      await new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        } else {
          setTimeout(resolve, 40);
        }
      });
    }

    return lastSnapshot;
  }

  async function generateThumbnailsWithProgress(files, progressDialog, generation, sourceFolder) {
    const results = new Array(files.length);

    for (let index = 0; index < files.length; index++) {
      if (generation.cancelled) {
        break;
      }

      const item = await captureModelThumbnail(files[index], sourceFolder);
      results[index] = item;
      generation.current = results.filter(Boolean).length;

      if (progressDialog) {
        updateProgressDialogState(progressDialog, generation);
      }
    }

    return results.filter(item => item && item.filePath);
  }

  function mergeGalleryItems(baseItems, newItems) {
    const seen = new Set();
    const merged = [];

    const pushUnique = (item) => {
      const key = String(item && item.filePath ? item.filePath : '');
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(item);
    };

    for (const item of baseItems || []) {
      pushUnique(item);
    }

    for (const item of newItems || []) {
      pushUnique(item);
    }

    return merged;
  }

  async function exportGalleryAsHtml() {
    const items = Array.isArray(cachedGalleryItems) ? cachedGalleryItems.filter(item => item && item.filePath) : [];
    if (!items.length) {
      showMessage('エクスポートするギャラリーがありません。');
      return;
    }

    if (typeof Filesystem === 'undefined' || !Filesystem || typeof Filesystem.exportFile !== 'function') {
      showMessage('Blockbench の Filesystem.exportFile API が利用できません。');
      return;
    }

    const defaultName = 'model-gallery-' + new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '') + '.html';
    const html = buildGalleryExportHtml(items);
    const defaultStartPath = galleryFolderHistory.length
      ? path.join(galleryFolderHistory[galleryFolderHistory.length - 1], defaultName)
      : defaultName;
    try {
      Filesystem.exportFile({
        resource_id: 'model_gallery_export',
        type: 'HTML File',
        extensions: ['html'],
        name: defaultName.replace(/\.html$/i, ''),
        startpath: defaultStartPath,
        content: html
      }, (savedPath) => {
        if (savedPath) {
          showMessage('ギャラリーをエクスポートしました。');
        }
      });
    } catch (error) {
      console.warn('[model_gallery] exportGalleryAsHtml failed', error);
      showMessage('ギャラリーのエクスポートに失敗しました。');
    }
  }

  function updateProgressDialogState(dialog, generation) {
    if (!dialog || !dialog.object) {
      return;
    }

    const total = Math.max(1, Number(generation && generation.total) || 1);
    const current = Math.min(Math.max(Number(generation && generation.current) || 0, 0), total);
    const percent = Math.min(Math.max(Math.round((current / total) * 100), 0), 100);

    const valueEl = dialog.object.querySelector('.mg-progress-value');
    const barEl = dialog.object.querySelector('.mg-progress-fill');
    if (valueEl) {
      valueEl.textContent = current + ' / ' + total + ' (' + percent + '%)';
    }
    if (barEl) {
      barEl.style.width = percent + '%';
    }
  }

  function cancelActiveGeneration() {
    if (activeGeneration) {
      activeGeneration.cancelled = true;
      if (activeGeneration.dialog && typeof activeGeneration.dialog.hide === 'function') {
        try {
          activeGeneration.dialog.hide();
        } catch (error) {
          console.warn('[model_gallery] cancelActiveGeneration hide failed', error);
        }
      }
    }
  }

  function showGalleryDialog(items) {
    cachedGalleryItems = Array.isArray(items) ? items : [];

    if (galleryDialog && typeof galleryDialog.hide === 'function') {
      try {
        galleryDialog.hide();
      } catch (error) {
        console.warn('[model_gallery] galleryDialog.hide failed', error);
      }
    }

    const tileMarkup = cachedGalleryItems.length
      ? cachedGalleryItems.map(item => {
          const safePath = escapeHtml(item.filePath);
          const safeName = escapeHtml(item.fileName);
          const imageMarkup = item.dataUrl
            ? '<img src="' + item.dataUrl + '" alt="' + safeName + '" />'
            : '<div class="mg-empty-thumb">No Preview</div>';

          return '<button class="mg-tile" type="button" data-path="' + safePath + '">' +
            '<div class="mg-thumb">' + imageMarkup + '</div>' +
            '<div class="mg-label">' + safeName + '</div>' +
            '</button>';
        }).join('')
      : '<div class="mg-empty-state">No models yet. Click “Add Folder” to load a resource pack.</div>';

    galleryDialog = new Dialog({
      id: 'model_gallery_dialog',
      title: 'Model Gallery',
      width: 900,
      height: 640,
      singleButton: true,
      buttons: ['Close'],
      lines: [
        '<style>' +
          '.mg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;padding:8px 6px 0;}' +
          '.mg-tile{background:#1a1d22;border:1px solid #3e4656;border-radius:8px;padding:8px;cursor:pointer;color:#e8edf5;display:flex;flex-direction:column;gap:8px;align-items:stretch;min-height:190px;transition:background .12s ease,border-color .12s ease;}' +
          '.mg-tile:hover{border-color:#5f88c7;background:#222833;color:#ffffff;}' +
          '.mg-tile:hover .mg-label{color:#ffffff;}' +
          '.mg-thumb{height:150px;border-radius:6px;background:#0e1115;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:6px;box-sizing:border-box;}' +
          '.mg-thumb img{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;background:#0e1115;}' +
          '.mg-empty-thumb{font-size:12px;color:#aab4c4;}' +
          '.mg-label{font-size:12px;line-height:1.4;word-break:break-word;color:inherit;}' +
          '.mg-folder-panel{margin:0 6px 8px;padding:10px 12px;border:1px solid #3e4656;border-radius:8px;background:#111419;}' +
          '.mg-folder-title{margin-bottom:8px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#9eabbd;}' +
          '.mg-folder-list{display:flex;flex-wrap:wrap;gap:6px;max-height:84px;overflow:auto;}' +
          '.mg-folder-row{display:flex;align-items:center;gap:6px;min-width:0;width:100%;}' +
          '.mg-folder-chip{display:inline-flex;align-items:center;max-width:100%;min-height:34px;padding:7px 10px;border-radius:6px;background:#212833;border:1px solid #3e4656;color:#d8e0eb;font-size:11px;line-height:1.2;word-break:break-all;box-sizing:border-box;}' +
          '.mg-folder-row .mg-folder-chip{flex:1 1 auto;min-width:0;}' +
          '.mg-folder-action{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:34px;height:34px;padding:0;border:1px solid #3e4656;border-radius:6px;background:#212833;color:#e8edf5;cursor:pointer;line-height:1.1;box-sizing:border-box;transition:background .12s ease,border-color .12s ease;}' +
          '.mg-folder-action:hover,.mg-folder-action:focus{border-color:#5f88c7;background:#2a313d;color:#ffffff !important;outline:none;}' +
          '.mg-folder-action:hover .material-icons,.mg-folder-action:focus .material-icons{color:#ffffff !important;}' +
          '.mg-folder-action .material-icons{font-size:16px;line-height:1;color:inherit;}' +
          '.mg-toolbar{display:flex;gap:8px;justify-content:flex-end;padding:8px 6px 0;align-items:center;flex-wrap:wrap;}' +
          '.mg-search-wrap{flex:1 1 auto;min-width:0;max-width:none;display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:6px;border:1px solid #3e4656;background:#111419;color:#e8edf5;box-sizing:border-box;}' +
          '.mg-search-wrap:focus-within{border-color:#5f88c7;background:#151b23;box-shadow:inset 0 0 0 1px rgba(135,172,255,.12);}' +
          '.mg-search-icon{display:inline-flex;align-items:center;justify-content:center;min-width:16px;min-height:16px;color:#aeb9c9;flex:0 0 auto;}' +
          '.mg-search-icon .material-icons{font-size:16px;line-height:1;display:block;color:inherit;}' +
          '.mg-search{flex:1;min-width:0;padding:6px 0;border:0;background:transparent;color:#e8edf5;outline:none;text-align:left;}' +
          '.mg-search::placeholder{color:#7a8697;}' +
          '.mg-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border:1px solid #3e4656;background:#212833;color:#e8edf5;border-radius:6px;cursor:pointer;line-height:1.1;min-height:34px;box-sizing:border-box;transition:background .12s ease,border-color .12s ease;}' +
          '.mg-action:hover,.mg-action:focus{border-color:#5f88c7;background:#2a313d;color:#ffffff !important;outline:none;}' +
          '.mg-action:hover .mg-action-label,.mg-action:focus .mg-action-label,.mg-action:hover .mg-action-icon,.mg-action:focus .mg-action-icon,.mg-action:hover .material-icons,.mg-action:focus .material-icons{color:#ffffff !important;}' +
          '.mg-action-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;min-width:16px;min-height:16px;opacity:.95;color:inherit;}' +
          '.mg-action-icon .material-icons{font-size:16px;line-height:1;display:block;color:inherit !important;}' +
          '.mg-action-label{display:inline-flex;align-items:center;line-height:1;color:inherit !important;}' +
          '.mg-empty-state{padding:28px 12px;color:#c0c9d4;text-align:center;line-height:1.6;}' +
        '</style>' +
        makeLoadedFoldersMarkup() +
        makeGalleryToolbarMarkup() +
        '<div class="mg-grid">' + tileMarkup + '</div>'
      ]
    });

    galleryDialog.onOpen = function () {
      const tileButtons = galleryDialog.object.querySelectorAll('.mg-tile');
      tileButtons.forEach(button => {
        button.addEventListener('click', () => {
          const filePath = button.getAttribute('data-path');
          if (filePath) {
            openModelInEditor(filePath);
          }
        });
      });

      const folderButtons = galleryDialog.object.querySelectorAll('.mg-folder-action');
      folderButtons.forEach(folderButton => {
        folderButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          const action = folderButton.getAttribute('data-action');
          const folderPath = folderButton.getAttribute('data-folder');
          if (!folderPath) {
            return;
          }

          if (action === 'open-folder') {
            openFolderInExplorer(folderPath);
          } else if (action === 'remove-folder') {
            removeFolderFromGallery(folderPath);
          }
        });
      });

      const actionButtons = galleryDialog.object.querySelectorAll('.mg-action');
      actionButtons.forEach(actionButton => {
        actionButton.addEventListener('click', async () => {
          const action = actionButton.getAttribute('data-action');
          if (action === 'add-folder') {
            const folder = await selectResourcePackFolder();
            if (!folder) {
              showMessage('フォルダが選択されませんでした。');
              return;
            }

            if (selectedFolder && String(selectedFolder).toLowerCase() === String(folder).toLowerCase()) {
              showMessage('現在表示中のフォルダと同じです。');
              return;
            }

            selectedFolder = folder;
            galleryFolderHistory = galleryFolderHistory.filter(existing => String(existing).toLowerCase() !== String(folder).toLowerCase());
            galleryFolderHistory.push(folder);
            await renderGalleryForFolder(folder, { append: true });
            return;
          }

          if (action === 'refresh-folder') {
            if (galleryFolderHistory && galleryFolderHistory.length) {
              await refreshGalleryForAllFolders();
            } else if (selectedFolder) {
              await renderGalleryForFolder(selectedFolder, { append: false });
            }
            return;
          }

          if (action === 'export-gallery') {
            await exportGalleryAsHtml();
            return;
          }

          if (action === 'reset-gallery') {
            const confirmDialog = new Dialog({
              id: 'model_gallery_reset_confirm',
              title: 'Reset Model Gallery',
              width: 360,
              height: 170,
              singleButton: false,
              buttons: ['Reset', 'Cancel'],
              confirmIndex: 0,
              cancelIndex: 1,
              lines: [
                '<div style="padding:18px; line-height:1.6;">',
                '<p>現在のギャラリー情報をリセットしますか？</p>',
                '<p style="color:#f7b267;">生成されたサムネイルとフォルダ選択のみがリセットされ、実際のファイルは削除されません。</p>',
                '</div>'
              ]
            });

            confirmDialog.onConfirm = function () {
              cachedGalleryItems = [];
              galleryFolderHistory = [];
              selectedFolder = null;
              if (galleryDialog && typeof galleryDialog.hide === 'function') {
                try { galleryDialog.hide(); } catch (error) {}
              }
              galleryDialog = null;
              showGalleryDialog([]);
            };

            confirmDialog.onCancel = function () {
              return;
            };

            confirmDialog.show();
          }
        });
      });

      // search filter: hide tiles whose filename/path doesn't match the query
      try {
        const searchInput = galleryDialog.object.querySelector('.mg-search');
        if (searchInput) {
          searchInput.addEventListener('input', () => {
            const q = String(searchInput.value || '').trim().toLowerCase();
            const tiles = galleryDialog.object.querySelectorAll('.mg-tile');
            tiles.forEach(t => {
              const labelEl = t.querySelector('.mg-label');
              const label = labelEl ? labelEl.textContent : '';
              const pathAttr = t.getAttribute('data-path') || '';
              const hay = (label + ' ' + pathAttr).toLowerCase();
              if (!q || hay.indexOf(q) !== -1) {
                t.style.display = 'flex';
              } else {
                t.style.display = 'none';
              }
            });
          });
        }
      } catch (e) {
        console.warn('[model_gallery] search input binding failed', e);
      }
    };

    galleryDialog.onClose = function () {
      galleryDialog = null;
    };

    galleryDialog.show();
  }

  async function renderGalleryForFolder(folderPath, options = {}) {
    const append = !!options.append;
    const scanResult = scanModelFiles(folderPath);
    const files = scanResult.modelFiles;
    const scanErrors = scanResult.errors;

    if (!files.length) {
      const dialog = new Dialog({
        id: 'model_gallery_empty_dialog',
        title: 'Model Gallery',
        width: 420,
        height: 180,
        singleButton: true,
        buttons: ['Close'],
        lines: [
          '<div style="padding:18px; line-height:1.6;">',
          '<p>このフォルダには .jem / .json モデルが見つかりませんでした。</p>',
          scanErrors.length ? '<p style="color:#d66;">' + scanErrors.slice(0, 2).map(err => escapeHtml(err)).join('<br>') + '</p>' : '',
          '</div>'
        ]
      });
      dialog.show();
      return;
    }

    const progressDialog = new Dialog({
      id: 'model_gallery_progress_dialog',
      title: 'Generating thumbnails',
      width: 360,
      height: 180,
      singleButton: false,
      buttons: ['Cancel'],
      confirmIndex: 0,
      cancelIndex: 0,
      lines: [
        '<div style="padding:18px 16px 12px; line-height:1.6;">' +
        '<div style="margin-bottom:10px;">サムネイルを生成中...</div>' +
        '<div style="font-weight:600; margin-bottom:8px;" class="mg-progress-value">0 / ' + files.length + ' (0%)</div>' +
        '<div style="height:10px; border-radius:999px; background:#1e232b; overflow:hidden; border:1px solid #3a4451;">' +
        '<div class="mg-progress-fill" style="width:0%; height:100%; background:linear-gradient(90deg, #71adff, #8af0c6); border-radius:999px;"></div>' +
        '</div>' +
        '</div>'
      ]
    });

    const generation = {
      cancelled: false,
      total: files.length,
      current: 0,
      dialog: progressDialog
    };
    activeGeneration = generation;

    progressDialog.onConfirm = function () {
      cancelActiveGeneration();
    };
    progressDialog.onCancel = function () {
      cancelActiveGeneration();
    };

    progressDialog.show();

    beginRecentHistoryGuard();
    try {
      const thumbnails = await generateThumbnailsWithProgress(files, progressDialog, generation, folderPath);
      if (generation.cancelled) {
        activeGeneration = null;
        return;
      }

      await waitForRecentHistorySettle();
      purgeRecentProjects(files);

      progressDialog.hide();
      activeGeneration = null;
      selectedFolder = folderPath;

      if (append) {
        cachedGalleryItems = mergeGalleryItems(cachedGalleryItems, thumbnails);
      } else {
        cachedGalleryItems = thumbnails;
      }

      galleryFolderHistory = galleryFolderHistory.filter(existing => String(existing).toLowerCase() !== String(folderPath).toLowerCase());
      galleryFolderHistory.push(folderPath);
      showGalleryDialog(cachedGalleryItems);
    } finally {
      await waitForRecentHistorySettle();
      endRecentHistoryGuard();
    }
  }

  async function refreshGalleryForAllFolders() {
    const folders = Array.from(new Set((galleryFolderHistory || []).map(folder => String(folder))));
    if (!folders.length) {
      showMessage('再読み込みするフォルダがありません。');
      return;
    }

    const refreshedItems = [];
    const generation = {
      cancelled: false,
      total: 0,
      current: 0,
      dialog: null
    };
    activeGeneration = generation;

    for (const folderPath of folders) {
      if (generation.cancelled) {
        break;
      }

      const scanResult = scanModelFiles(folderPath);
      const files = scanResult.modelFiles || [];

      if (!files.length) {
        continue;
      }

      generation.total = files.length;
      generation.current = 0;

      const progressDialog = new Dialog({
        id: 'model_gallery_progress_dialog',
        title: 'Refreshing thumbnails',
        width: 360,
        height: 180,
        singleButton: false,
        buttons: ['Cancel'],
        confirmIndex: 0,
        cancelIndex: 0,
        lines: [
          '<div style="padding:18px 16px 12px; line-height:1.6;">' +
          '<div style="margin-bottom:10px;">サムネイルを更新中...</div>' +
          '<div style="font-weight:600; margin-bottom:8px;" class="mg-progress-value">0 / ' + files.length + ' (0%)</div>' +
          '<div style="height:10px; border-radius:999px; background:#1e232b; overflow:hidden; border:1px solid #3a4451;">' +
          '<div class="mg-progress-fill" style="width:0%; height:100%; background:linear-gradient(90deg, #71adff, #8af0c6); border-radius:999px;"></div>' +
          '</div>' +
          '</div>'
        ]
      });

      progressDialog.onConfirm = function () {
        cancelActiveGeneration();
      };
      progressDialog.onCancel = function () {
        cancelActiveGeneration();
      };

      generation.dialog = progressDialog;
      progressDialog.show();

      beginRecentHistoryGuard();
      try {
        const thumbnails = await generateThumbnailsWithProgress(files, progressDialog, generation, folderPath);

        if (generation.cancelled) {
          activeGeneration = null;
          return;
        }

        await waitForRecentHistorySettle();
        purgeRecentProjects(files);

        refreshedItems.push(...thumbnails);
      } finally {
        await waitForRecentHistorySettle();
        endRecentHistoryGuard();
        progressDialog.hide();
        generation.dialog = null;
      }
    }

    if (generation.cancelled) {
      activeGeneration = null;
      return;
    }

    activeGeneration = null;
    cachedGalleryItems = mergeGalleryItems([], refreshedItems);
    selectedFolder = folders[folders.length - 1];
    showGalleryDialog(cachedGalleryItems);
  }

  const plugin = {
    title: 'Model Gallery',
    author: 'alumina6767',
    description: 'Minimal test plugin for Blockbench',
    icon: 'menu_book',
    version: '0.0.29',
    min_version: '4.8.0',
    variant: 'both',

    onload() {
      console.log('[model_gallery] plugin loaded');

      try {
        if (typeof Dialog !== 'undefined' && Dialog && !Dialog.__mg_patched) {
          const _origShow = Dialog.prototype.show;
          Dialog.prototype.show = function () {
            try {
              if (mgDialogSuppress.enabled) {
                mgDialogSuppress.captured.push(this);
              }
            } catch (e) {
              console.warn('[model_gallery] dialog suppression push failed', e);
            }
            return _origShow.apply(this, arguments);
          };
          Dialog.__mg_patched = true;
        }
      } catch (e) {
        console.warn('[model_gallery] dialog patch failed', e);
      }

      button = new Action(ACTION_ID, {
        name: 'Open Model Gallery',
        icon: 'menu_book',
        click: async function () {
          if (galleryDialog) {
            showGalleryDialog(cachedGalleryItems);
            return;
          }

          if (selectedFolder && cachedGalleryItems.length) {
            showGalleryDialog(cachedGalleryItems);
            return;
          }

          if (selectedFolder && !cachedGalleryItems.length) {
            showGalleryDialog([]);
            return;
          }

          showGalleryDialog([]);
        }
      });

      MenuBar.menus.tools.addAction(button);
    },

    onunload() {
      console.log('[model_gallery] plugin unloaded');
      if (button) {
        button.delete();
      }
    }
  };

  Plugin.register('model_gallery', plugin);
})();
