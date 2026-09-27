import { config } from '../config';

export function getAxiosProxyConfig(): any {
  if (!config.HTTP_PROXY) return undefined;
  try {
    const url = new URL(config.HTTP_PROXY);
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
      auth: url.username
        ? {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password)
          }
        : undefined
    };
  } catch (err) {
    return undefined;
  }
}
