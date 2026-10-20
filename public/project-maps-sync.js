// --- Projects from wayfinder maps: keep them in step (project-maps.js) ---
// Main makes a project for every wayfinder map you are involved in and keeps
// its status with the map's. This asks it to: shortly after start, when the
// Projects tab is opened, and every ten minutes. Main tells the views itself
// when projects change.

const PROJECT_MAPS_SYNC_MS = 10 * 60 * 1000;
const projectMapsSync = { running: null, last: 0 };

/** One run at a time; a click right after a run does not start another. */
function syncProjectMaps({ soon = false } = {}) {
  if (projectMapsSync.running || (soon && Date.now() - projectMapsSync.last < 60 * 1000)) return projectMapsSync.running;
  projectMapsSync.running = window.api.syncMapProjects()
    .then(result => { if (result?.error) console.warn('[project-maps]', result.error); })
    .catch(() => {})
    .finally(() => { projectMapsSync.running = null; projectMapsSync.last = Date.now(); });
  return projectMapsSync.running;
}

document.addEventListener('click', (e) => {
  if (e.target.closest?.('.sidebar-tab[data-tab="projects"]')) syncProjectMaps({ soon: true });
});
setTimeout(() => syncProjectMaps(), 15 * 1000);
setInterval(() => syncProjectMaps(), PROJECT_MAPS_SYNC_MS);
