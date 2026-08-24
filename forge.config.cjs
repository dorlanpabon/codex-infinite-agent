module.exports = {
  packagerConfig: {
    asar: { unpackDir: 'native/windows-job-wrapper/bin' },
    appBundleId: 'com.codexinfinite.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    executableName: 'CodexInfinite',
    name: 'Codex Infinite',
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/(?:src|test|scripts|\.github)(?:\/|$)/,
      /^\/native\/windows-job-wrapper\/(?:src|target)(?:\/|$)/,
      /^\/native\/windows-job-wrapper\/(?:Cargo\.toml|Cargo\.lock)$/,
      /^\/dist\/.*\.(?:map|d\.ts)$/,
      /^\/(?:package-lock\.json|tsconfig\.json)$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: { name: 'CodexInfinite', authors: 'Codex Infinite contributors' },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-deb', platforms: ['linux'], config: {} },
    { name: '@electron-forge/maker-rpm', platforms: ['linux'], config: {} },
  ],
};
