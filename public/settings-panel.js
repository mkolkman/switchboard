// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
    // Terminals had no layout box while the panel covered them, so anything that
    // changed their metrics in the meantime (font size, line height) could not fit
    // itself and would leave output running off the right edge until the next resize.
    if (typeof window._refitOpenTerminals === 'function') window._refitOpenTerminals();
  }

  async function openSettingsViewer(scope, projectPath) {
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};
    // What actually runs when nothing is stored: the app's defaults under the
    // saved global values. A fresh install shows these, not blanks.
    const appDefaults = (await window.api.getEffectiveSettings(null).catch(() => null)) || {};

    const shortName = isProject
      ? shortProjectPath(projectPath)
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Folder Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    if (typeof hideProjectChrome === 'function') hideProjectChrome();
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    settingsViewer.style.display = 'flex';

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    }

    function fieldValue(fieldName, fallback) {
      const set = (v) => v !== undefined && v !== null;
      if (isProject && !set(current[fieldName])) {
        if (set(globalSettings[fieldName])) return globalSettings[fieldName];
        return set(appDefaults[fieldName]) ? appDefaults[fieldName] : fallback;
      }
      if (set(current[fieldName])) return current[fieldName];
      return set(appDefaults[fieldName]) ? appDefaults[fieldName] : fallback;
    }

    function fieldDisabled(fieldName) {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    }

    // Fetched before the template so the toggles render as direct children of
    // their section: the card's rounded top and bottom come from
    // `.settings-section > .settings-field`, which a wrapper div would break.
    const harnesses = isProject ? [] : await window.api.getHarnesses().catch(() => []);
    const harnessFields = harnesses.map(h => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(h.label)}</span>
            <div class="settings-description">Scan for <code>${escapeHtml(h.id)}</code> sessions, show them, and offer it when starting one</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" class="sv-harness-toggle" data-harness="${escapeHtml(h.id)}" ${h.enabled ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>`).join('');

    const permModeValue = fieldValue('permissionMode', '');
    const codexSandboxValue = fieldValue('codexSandbox', '');
    const codexApprovalValue = fieldValue('codexApproval', '');
    const codexModelValue = fieldValue('codexModel', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const customersValue = Array.isArray(current.customers) ? current.customers : [];
    const themeValue = fieldValue('terminalTheme', 'switchboard');
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    // Global-only: where new projects get their folder (projects.js). Empty
    // means the default, ~/Switchboard.
    const projectsRootValue = (!isProject && typeof current.projectsRoot === 'string') ? current.projectsRoot : '';
    // Global-only: where a quick session starts (sidebar-keyboard.js).
    const quickSessionPathValue = (!isProject && typeof current.quickSessionPath === 'string') ? current.quickSessionPath : '';
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    // Global-only: the Notion todo list (notion-todo.js). The token itself
    // never comes back from main, only whether one is saved.
    const notionTodo = !isProject ? await window.api.getNotionTodoConfig().catch(() => null) : null;
    const fontFamilyValue = fieldValue('terminalFontFamily', '');
    const fontSizeValue = fieldValue('terminalFontSize', DEFAULT_TERMINAL_FONT_SIZE);
    const lineHeightValue = fieldValue('terminalLineHeight', DEFAULT_TERMINAL_LINE_HEIGHT);

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      ${harnessFields ? `<div class="settings-section">
        <div class="settings-section-title">CLI Agents</div>${harnessFields}
      </div>` : ''}

      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              ${PERMISSION_MODES.map(m => m.value === null
                ? '<option value="">Default (none)</option>'
                : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
              ${useGlobalCheckbox('chrome')}
            </div>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Codex CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Sandbox</span>
              ${useGlobalCheckbox('codexSandbox')}
            </div>
            <div class="settings-description">What <code>codex</code> is allowed to touch. Leave on Default to use codex's own config.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-codex-sandbox" ${fieldDisabled('codexSandbox')}>
              ${CODEX_SANDBOX_MODES.map(m => `<option value="${m.value}" ${codexSandboxValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Approval</span>
              ${useGlobalCheckbox('codexApproval')}
            </div>
            <div class="settings-description">When codex stops to ask before running a command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-codex-approval" ${fieldDisabled('codexApproval')}>
              ${CODEX_APPROVAL_POLICIES.map(m => `<option value="${m.value}" ${codexApprovalValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Model</span>
              ${useGlobalCheckbox('codexModel')}
            </div>
            <div class="settings-description">Passed as <code>--model</code>; blank uses codex's default</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-codex-model" placeholder="default" value="${escapeHtml(codexModelValue)}" ${fieldDisabled('codexModel')} style="width:140px">
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Color theme for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Font</span>
            <div class="settings-description">Font family for terminal sessions. Leave empty for the default.<span id="sv-font-warning" class="settings-warning"></span></div>
          </div>
          <div class="settings-field-control">
            <!-- value/placeholder set as properties below: font stacks contain quotes, which escapeHtml leaves alone -->
            <input type="text" class="settings-input" id="sv-font-family" style="width:220px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Font Size</span>
            <div class="settings-description">Font size in pixels for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-font-size" min="6" max="32" step="1" value="${fontSizeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Line Height</span>
            <div class="settings-description">Line spacing as a multiple of the font size (1 = tightest)</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-line-height" min="1" max="3" step="0.05" value="${lineHeightValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions per folder or project track before collapsing the rest</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Quick Session Folder</span>
            <div class="settings-description">Where the lightning button, ${isMac ? '\u2318N' : 'Ctrl+N'} and N (outside a session) start Claude straight away: a full path. Empty hides the button.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-quick-session-path" placeholder="/Users/you/Sources" value="${escapeHtml(quickSessionPathValue)}" spellcheck="false">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Projects Folder</span>
            <div class="settings-description">Where new projects are created. Existing projects stay where they are.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-projects-root" placeholder="~/Switchboard" value="${escapeHtml(projectsRootValue)}" spellcheck="false">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Project Templates</span>
            <div class="settings-description">One folder per template, each with a <code>template.json</code> and the files a new project starts with. Add a folder to add a template. <span id="sv-templates-dir"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-open-templates" type="button">Open Folder</button>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Customers</div>
        <div class="settings-field settings-field-stacked">
          <div class="settings-field-info">
            <span class="settings-label">Customer Mapping</span>
            <div class="settings-description">Used when the sidebar is grouped by customer. One customer per line: a name, a colon, then repository or folder names separated by commas. <code>*</code> matches anything, matching ignores case, and the first matching line wins. Unmatched repositories go under "${escapeHtml(OTHER_CUSTOMER)}".</div>
          </div>
          <div class="settings-field-control">
            <textarea class="settings-input settings-textarea" id="sv-customers" rows="6" spellcheck="false" placeholder="CityRow: CityRow-*&#10;NOHRD: NOHRD-*, WATERROWER-*&#10;RP3: RP3-*">${escapeHtml(formatCustomerMapping(customersValue))}</textarea>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Notion todo list</div>
        <div class="settings-field settings-field-stacked">
          <div class="settings-field-info">
            <span class="settings-label">Integration token</span>
            <div class="settings-description">From an internal integration at notion.so/profile/integrations, with read, update and insert content. Share the todo page with it (••• &gt; Connections). Stored encrypted on this Mac. Leave empty to keep the saved token.</div>
          </div>
          <div class="settings-field-control">
            <input type="password" class="settings-input" id="sv-notion-token" autocomplete="off" spellcheck="false" placeholder="${notionTodo?.hasToken ? 'Saved' : 'ntn_…'}">
            ${notionTodo?.hasToken ? '<label class="settings-inline-check"><input type="checkbox" id="sv-notion-forget"> Forget the saved token</label>' : ''}
          </div>
        </div>
        <div class="settings-field settings-field-stacked">
          <div class="settings-field-info">
            <span class="settings-label">Todo page</span>
            <div class="settings-description">The link to the page the Todo tab shows: sections as headings (This week, Next week, Later, Thinkering Ideas, Archive), todos as checkboxes.</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-notion-page" spellcheck="false" placeholder="https://www.notion.so/…" value="${escapeHtml(notionTodo?.pageUrl || '')}">
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Version</span>
            <div class="settings-description"><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
          </div>
        </div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Folder</button>' : ''}
      </div>
    </div>
  `;

    // At least one CLI has to stay on, or the sidebar has nothing to show and
    // the "+" menu nothing to offer. The last one still switched on is locked
    // rather than hidden, so the reason is visible. Main refuses an all-off
    // state too, for any writer that does not come through this panel.
    const harnessToggles = [...settingsViewerBody.querySelectorAll('.sv-harness-toggle')];
    function syncHarnessLock() {
      const on = harnessToggles.filter(t => t.checked);
      for (const t of harnessToggles) {
        const lock = on.length === 1 && t.checked;
        t.disabled = lock;
        const field = t.closest('.settings-field');
        const desc = field?.querySelector('.settings-description');
        if (desc && lock && !desc.dataset.originalText) {
          desc.dataset.originalText = desc.innerHTML;
          desc.textContent = 'Kept on — at least one CLI must stay enabled';
        } else if (desc && !lock && desc.dataset.originalText) {
          desc.innerHTML = desc.dataset.originalText;
          delete desc.dataset.originalText;
        }
      }
    }
    harnessToggles.forEach(t => t.addEventListener('change', syncHarnessLock));
    syncHarnessLock();
    const fontFamilyInput = settingsViewerBody.querySelector('#sv-font-family');
    if (fontFamilyInput) {
      fontFamilyInput.value = fontFamilyValue;
      fontFamilyInput.placeholder = DEFAULT_TERMINAL_FONT_FAMILY;
      // Without this the fallback is invisible: naming a font you don't have installed
      // looks identical to the setting not working at all.
      const fontWarning = settingsViewerBody.querySelector('#sv-font-warning');
      const checkFontAvailable = () => {
        const name = fontFamilyInput.value.trim();
        fontWarning.textContent = !name || isFontAvailable(name)
          ? ''
          : ` “${name}” is not installed, so the default font is used.`;
      };
      fontFamilyInput.addEventListener('input', checkFontAvailable);
      checkFontAvailable();
    }

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const fieldMap = {
          permissionMode: 'sv-perm-mode',
          worktree: 'sv-worktree',
          worktreeName: 'sv-worktree-name',
          chrome: 'sv-chrome',
          preLaunchCmd: 'sv-pre-launch',
          addDirs: 'sv-add-dirs',
          codexSandbox: 'sv-codex-sandbox',
          codexApproval: 'sv-codex-approval',
          codexModel: 'sv-codex-model',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
      });
    });

    // Project templates folder (global only)
    const openTemplates = settingsViewerBody.querySelector('#sv-open-templates');
    if (openTemplates) {
      window.api.listTemplates().then(result => {
        const dirEl = settingsViewerBody.querySelector('#sv-templates-dir');
        if (dirEl && result?.dir) dirEl.textContent = result.dir;
        openTemplates.onclick = () => { if (result?.dir) window.api.openPath(result.dir); };
      }).catch(() => {});
    }

    // Save button
    settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
      let settings = {};

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
              codexSandbox: () => settingsViewerBody.querySelector('#sv-codex-sandbox').value,
              codexApproval: () => settingsViewerBody.querySelector('#sv-codex-approval').value,
              codexModel: () => settingsViewerBody.querySelector('#sv-codex-model').value.trim(),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.codexSandbox = settingsViewerBody.querySelector('#sv-codex-sandbox').value;
        settings.codexApproval = settingsViewerBody.querySelector('#sv-codex-approval').value;
        settings.codexModel = settingsViewerBody.querySelector('#sv-codex-model').value.trim();
        // Store the disabled set rather than the enabled one, so a CLI added in
        // a later version is on by default instead of silently missing.
        // Includes locked and unavailable toggles: `disabled` only stops the
        // user changing them, their checked state is still the setting.
        const toggles = [...settingsViewerBody.querySelectorAll('.sv-harness-toggle')];
        if (toggles.length) {
          settings.disabledHarnesses = toggles.filter(t => !t.checked).map(t => t.dataset.harness);
        }
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
        settings.projectsRoot = settingsViewerBody.querySelector('#sv-projects-root').value.trim();
        settings.quickSessionPath = settingsViewerBody.querySelector('#sv-quick-session-path').value.trim();
        settings.customers = parseCustomerMapping(settingsViewerBody.querySelector('#sv-customers').value);
        // Store the family verbatim (empty = follow the default stack, even if that
        // stack later changes) but store size/line height clamped to what xterm accepts.
        const font = normalizeTerminalFont({
          fontSize: settingsViewerBody.querySelector('#sv-font-size').value,
          lineHeight: settingsViewerBody.querySelector('#sv-line-height').value,
        });
        settings.terminalFontFamily = settingsViewerBody.querySelector('#sv-font-family').value.trim();
        settings.terminalFontSize = font.fontSize;
        settings.terminalLineHeight = font.lineHeight;
      }

      // Merge form values into existing settings to preserve keys not managed by the form
      if (!isProject) {
        const existing = (await window.api.getSetting('global')) || {};
        settings = { ...existing, ...settings };
      }

      await window.api.setSetting(settingsKey, settings);

      if (!isProject) {
        const token = settingsViewerBody.querySelector('#sv-notion-token').value.trim();
        const forget = settingsViewerBody.querySelector('#sv-notion-forget')?.checked;
        const page = settingsViewerBody.querySelector('#sv-notion-page').value.trim();
        const spec = { page };
        if (token) spec.token = token;
        else if (forget) spec.token = '';
        const saved = await window.api.setNotionTodoConfig(spec);
        if (saved?.error) alert(saved.error);
        else if (typeof todoConfigChanged === 'function') todoConfigChanged();
      }

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
          window._setSessionMaxAge(settings.sessionMaxAgeDays);
        }
        if (typeof window._setCustomerMapping === 'function') window._setCustomerMapping(settings.customers);
        if (typeof syncQuickSessionButton === 'function') syncQuickSessionButton();
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
          window._applyTerminalTheme(settings.terminalTheme);
        }
        if (typeof window._applyTerminalFont === 'function') {
          window._applyTerminalFont({
            fontFamily: settings.terminalFontFamily,
            fontSize: settings.terminalFontSize,
            lineHeight: settings.terminalLineHeight,
          });
        }
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }

      // Notify if IDE Emulation changed
      if (!isProject && settings.mcpEmulation !== mcpEmulationValue) {
        const notice = document.createElement('div');
        notice.className = 'settings-notice';
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
        const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
        saveBtn.parentElement.insertBefore(notice, saveBtn);
        setTimeout(() => notice.remove(), 8000);
      }

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#2ea043';
      saveBtn.style.color = '#fff';
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      closeSettingsViewer();
    });

    // Check for updates button + current version + inline status
    const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
    if (checkUpdatesBtn) {
      const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
      window.api.getAppVersion().then(v => {
        const el = settingsViewerBody.querySelector('#sv-current-version');
        if (el) el.textContent = `v${v}`;
      });
      const settingsUpdaterHandler = (type, data) => {
        if (!updateStatusEl) return;
        switch (type) {
          case 'checking': updateStatusEl.textContent = '\u2014 checking\u2026'; break;
          case 'update-available': updateStatusEl.textContent = `\u2014 v${data.version} available`; break;
          case 'update-not-available': updateStatusEl.textContent = '\u2014 up to date'; break;
          case 'download-progress': updateStatusEl.textContent = `\u2014 downloading ${Math.round(data.percent)}%`; break;
          case 'update-downloaded': updateStatusEl.textContent = `\u2014 v${data.version} ready, restart to update`; break;
          case 'error': updateStatusEl.textContent = '\u2014 check failed'; break;
        }
      };
      window.api.onUpdaterEvent(settingsUpdaterHandler);
      checkUpdatesBtn.addEventListener('click', () => {
        window.api.updaterCheck();
      });
    }

    // Remove project button
    const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
        await window.api.removeProject(projectPath);
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
