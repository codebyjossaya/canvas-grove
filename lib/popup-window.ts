export const SECURE_BROWSER_WINDOW_NAME = "canvas-grove-secure-browser";

type ScreenBounds = { availWidth?: number; availHeight?: number; availLeft?: number; availTop?: number };

export function secureBrowserPopupFeatures(screen: ScreenBounds) {
  const availableWidth = Math.max(280, Math.floor(screen.availWidth || 1200));
  const availableHeight = Math.max(320, Math.floor(screen.availHeight || 800));
  const width = Math.min(availableWidth, Math.max(280, Math.floor(availableWidth * .92)));
  const height = Math.min(availableHeight, Math.max(320, Math.floor(availableHeight * .9)));
  const left = Math.floor((screen.availLeft || 0) + (availableWidth - width) / 2);
  const top = Math.floor((screen.availTop || 0) + (availableHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
}
