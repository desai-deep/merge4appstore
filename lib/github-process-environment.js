const EXACT_KEYS = new Set([
  'HOME',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'TERM',
  'NO_COLOR',
  'XDG_CONFIG_HOME',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSH_AUTH_SOCK',
]);

export function githubProcessEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => (
    EXACT_KEYS.has(key) || key.startsWith('LC_')
  )));
}
