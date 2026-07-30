/**
 * Configuration — set these in Script Properties:
 *   BACKEND_URL = https://your-replit-app.replit.app
 *   API_KEY     = same value as ADDON_API_KEY in your backend .env
 */

function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    backendUrl: props.getProperty('BACKEND_URL') || 'http://localhost:3000',
    apiKey: props.getProperty('API_KEY') || '',
  };
}

/**
 * Make an authenticated request to the backend API.
 */
function apiRequest_(method, path, payload) {
  var config = getConfig_();
  var url = config.backendUrl + path;

  var options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    },
    muteHttpExceptions: true,
  };

  if (payload && (method === 'post' || method === 'POST')) {
    options.payload = JSON.stringify(payload);
  }

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();

  if (code >= 400) {
    throw new Error('API error ' + code + ': ' + response.getContentText().substring(0, 200));
  }

  return JSON.parse(response.getContentText());
}
