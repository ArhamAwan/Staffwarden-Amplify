// Windows builds made on Linux or macOS: electron-builder needs Wine to put the icon and version details
// into Staffwarden.exe, so that step is turned off (win.signAndEditExecutable) and done here in plain JS.
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const name = ctx.packager.appInfo.productFilename;
  const exePath = path.join(ctx.appOutDir, `${name}.exe`);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
  const v = ctx.packager.appInfo.version;
  const [a, b, c] = v.split('.').map(Number);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Staffwarden', ProductName: 'Staffwarden', CompanyName: 'Amplify Media Technologies',
    LegalCopyright: 'Copyright (c) 2026 Amplify Media Technologies', OriginalFilename: `${name}.exe`, InternalName: 'Staffwarden',
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • set icon and version details on', path.basename(exePath));
};
