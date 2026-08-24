const { version } = require('./package.json');

const homepage = 'https://github.com/dorlanpabon/codex-infinite-agent';
const description = 'Durable native-Goal companion for the ChatGPT Codex Desktop App Server';
const nativeIgnore = process.platform === 'win32'
  ? [
    /^\/native\/(?!windows-job-wrapper(?:\/|$)).+/,
    /^\/native\/windows-job-wrapper\/(?!bin(?:\/|$)).+/,
    /^\/native\/windows-job-wrapper\/bin\/(?!windows-x64(?:\/|$)).+/,
    /^\/native\/windows-job-wrapper\/bin\/windows-x64\/(?!codex-infinite-job-wrapper\.exe$).+/,
  ]
  : [/^\/native(?:\/|$)/];

module.exports = {
  packagerConfig: {
    asar: { unpackDir: 'native/windows-job-wrapper/bin' },
    appBundleId: 'com.dorlanpabon.codex-infinite',
    appCategoryType: 'public.app-category.developer-tools',
    executableName: 'CodexInfinite',
    name: 'Codex Infinite',
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/(?:src|test|scripts|\.github)(?:\/|$)/,
      ...nativeIgnore,
      /^\/node_modules\/(?!electron-squirrel-startup(?:\/|$)|debug(?:\/|$)|ms(?:\/|$)).+/,
      /^\/dist\/.*\.(?:map|d\.(?:c|m)?ts)$/,
      /^\/(?:package-lock\.json|tsconfig\.json)$/,
      /^\/(?!dist(?:\/|$)|native(?:\/|$)|node_modules(?:\/|$)|package\.json$|README\.md$|SECURITY\.md$|LICENSE$).+/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'CodexInfinite',
        authors: 'dorlanpabon',
        description,
        setupExe: `Codex-Infinite-${version}-Setup.exe`,
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'codex-infinite',
          productName: 'Codex Infinite',
          genericName: 'AI Development Tool',
          description,
          productDescription: description,
          section: 'devel',
          maintainer: 'dorlanpabon',
          homepage,
          categories: ['Development'],
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'codex-infinite',
          productName: 'Codex Infinite',
          genericName: 'AI Development Tool',
          description,
          productDescription: description,
          license: 'MIT',
          group: 'Development/Tools',
          homepage,
          categories: ['Development'],
        },
      },
    },
  ],
};
