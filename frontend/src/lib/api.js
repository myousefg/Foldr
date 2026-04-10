import axios from 'axios';

// In Electron the backend always runs locally on port 8765
const BASE = 'http://127.0.0.1:8765/api';

const api = axios.create({ baseURL: BASE, headers: { 'Content-Type': 'application/json' } });

export const rulesApi = {
  getAll:        ()       => api.get('/rules').then(r => r.data),
  create:        (data)   => api.post('/rules', data).then(r => r.data),
  update:        (id, d)  => api.put(`/rules/${id}`, d).then(r => r.data),
  delete:        (id)     => api.delete(`/rules/${id}`).then(r => r.data),
  reorder:       (ids)    => api.put('/rules/reorder', { rule_ids: ids }).then(r => r.data),
  getTemplates:  ()       => api.get('/rules/templates').then(r => r.data),
  applyTemplate: (type)   => api.post(`/rules/templates/${type}`).then(r => r.data),
};

export const organizeApi = {
  preview:  (filenames) => api.post('/organize/preview', { filenames }).then(r => r.data),
};

export const pendingApi = {
  getAll: ()    => api.get('/pending').then(r => r.data),
  apply:  (ids) => api.post('/pending/apply', { ids }).then(r => r.data),
  skip:   (id)  => api.delete(`/pending/${id}`).then(r => r.data),
  clear:  ()    => api.delete('/pending').then(r => r.data),
};

export const activityApi = {
  getAll: (limit = 50) => api.get(`/activity?limit=${limit}`).then(r => r.data),
  undo:   (id)         => api.post(`/activity/${id}/undo`).then(r => r.data),
  clear:  ()           => api.delete('/activity').then(r => r.data),
};

export const settingsApi = {
  get:    ()     => api.get('/settings').then(r => r.data),
  update: (data) => api.put('/settings', data).then(r => r.data),
};

export const statsApi = {
  get: () => api.get('/stats').then(r => r.data),
};

export const foldersApi = {
  getAll:    ()     => api.get('/folders').then(r => r.data),
  getFiles:  (name) => api.get(`/folders/${encodeURIComponent(name)}`).then(r => r.data),
};
