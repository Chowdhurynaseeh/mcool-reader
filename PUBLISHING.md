# Build, test, and publish MCOOL Reader

These steps are for the extension maintainer. Users install MCOOL Reader from VS Code and open their `.cool` or `.mcool` files.

## 1. Build a test VSIX

Install Node.js 22 or later on your development machine, then open a terminal in this project folder. The packaging tool is pinned by the project. [VS Code Extension Manager](https://github.com/microsoft/vscode-vsce)

```sh
npm ci
npm run build
npm run package -- --allow-missing-repository --skip-license
```

The command creates `mcool-reader-0.4.0.vsix` in the project folder with the `local-development` publisher. The flags are for the local test build while your repository and extension license are being chosen. Press **F5** in the project to debug the source in an Extension Development Host.

## 2. Test the packaged extension

In VS Code, run **Profiles: Create a Temporary Profile** from the Command Palette. In the temporary profile, run **Extensions: Install from VSIX...** and choose the package you just built. Repeat the checks with the final publisher's VSIX before uploading it. [VS Code profiles](https://code.visualstudio.com/docs/configure/profiles#_what-is-a-temporary-profile) · [Install from VSIX](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)

| Check | Expected result |
| --- | --- |
| Open `examples/GM12878_vhic_p0.01_s0.mcool` from the project folder. | A heatmap loads in the custom editor with a 100 kb stored resolution. The file opens without Python, a virtual environment, or extension configuration. |
| Open **Metadata** for the same file. | It lists 23 chromosomes, 30,321 bins, 1,511,017 stored pixels, and 6,540,390 total contacts. The total has a compact label of **6.54M**. The chr1 length has a compact **Mb** label and an exact length of **248,956,422 bp**. |
| Open a `.mcool` with multiple resolutions and a standalone `.cool`. | The `.mcool` resolution selector offers each stored level and switching levels updates the metadata and map. The `.cool` opens as a single-resolution file. |
| At 100 kb, draw chr19 from `12000000` to `14000000`. | The map shows 20 bins per axis. With a 200 kb display bin and **Raw counts**, it shows 10. With default weights available at the stored bin size, **Balanced** can be selected. |
| Zoom with the toolbar and with Ctrl/Cmd plus scroll over the map. Drag, reset, and inspect with keyboard arrows. | The zoom responds, wheel zoom follows the pointer, dragging pans the view, and reset fits the full region. Keyboard inspection updates the active bin pair. |
| Switch palette and color scale, then select **Export PNG**. | The saved image opens with the rendered palette and scale. |
| Open a file with a `.cool` name and invalid contents. | The editor shows a readable file error and VS Code remains responsive. |
| Install the VSIX in a connected SSH, WSL, or dev container window and open a file on the remote host. | The same viewer opens the remote file with the bundled reader. |

Run these checks on the desktop platforms you intend to support, including macOS, Windows and Linux. Test in a light and a dark theme and with the oldest VS Code version you claim to support.

## 3. Set your public publisher and release details

1. Sign in to Visual Studio Marketplace with your Microsoft account. Create a publisher or open the one you already own. Choose an ID you want to keep, since it forms part of the extension's identity. [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/)
2. In `package.json`, replace `local-development` with your publisher ID. Keep `name` as `mcool-reader` for the planned listing. The full Marketplace identifier will be `YOUR_PUBLISHER.mcool-reader`.
3. Add your repository URL and issue tracker to `package.json` using the `repository` and `bugs` fields. Set the license you choose for your extension and include its text in a root `LICENSE` file. Keep the bundled dependency notices with the distribution. [Extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest)
4. Check `README.md` and `CHANGELOG.md` for accuracy. Use a fresh version for each upload. If this is the first Marketplace release, use `0.4.0`.
5. Rebuild the package with the public identity and repeat the installed-extension checks against that package.

   ```sh
   npm ci
   npm run package
   ```

Open the `.vsix` as a ZIP archive if you want to confirm the contents. It should contain the compiled extension, the viewer assets, the HDF5 runtime, and the documentation and license files. Keep development dependencies, local environments, and your example data outside the package.

## 4. Upload the tested VSIX

1. Sign in and open your publisher. [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/)
2. Use **New extension > Visual Studio Code** for the first upload. For an existing listing, open its actions menu and choose **Update**.
3. Choose the tested `.vsix` with your publisher ID and select **Upload**. Wait for its Marketplace validation to finish. [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_publish-an-extension)
4. Open the public listing and check the description, icon, version, and links. In a clean VS Code profile, search for `@id:YOUR_PUBLISHER.mcool-reader`, install from the Marketplace, and open a Cooler file.

For an invite-only test, share the test VSIX directly. To use the Marketplace pre-release channel, package with `npm run package -- --pre-release` and use a version distinct from any stable release. [Marketplace pre-release guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#_prerelease-extensions)
