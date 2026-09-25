// Picks the club's own icon/logo (set as env vars) or falls back to a plain placeholder, so the
// system works before any artwork has been supplied. See own-wallet/README.md.
'use strict';

const { defaultAppleImages } = require('./pngGenerator.js');

function appleImages(config) {
  const placeholder = defaultAppleImages();
  return {
    iconPng: config.images.iconPng || placeholder.iconPng,
    icon2xPng: config.images.icon2xPng || placeholder.icon2xPng,
    logoPng: config.images.logoPng || placeholder.logoPng,
    logo2xPng: config.images.logo2xPng || placeholder.logo2xPng,
  };
}

module.exports = { appleImages };
