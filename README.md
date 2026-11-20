# MCOOL Reader

Open Hi-C contact maps from `.cool` and `.mcool` files directly in VS Code. Explore a chromosome as a heatmap and inspect file metadata in tables. The extension includes its HDF5 reader and opens data read-only. There are no Python packages or extension settings to configure.

## Install and open a file

1. In desktop VS Code, open **Extensions**, search for **MCOOL Reader**, and select **Install** once the extension is listed. If you received a test `.vsix`, run **Extensions: Install from VSIX...** in the Command Palette and select that file. VS Code can ask you to confirm that you trust the publisher during installation. [VS Code installation guide](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix) · [Publisher trust](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)
2. Open a `.cool` or `.mcool` file from the Explorer or **File > Open File...**. The first contact map loads automatically.
3. If VS Code opens the file in another editor, run **Reopen Editor With...** and choose **MCOOL Reader**. Use **Configure default editor for…** in that menu if you want to change the saved file association.

For Remote SSH, WSL, or a dev container, install MCOOL Reader in the connected VS Code window on the host that holds the files. [VS Code remote extension guide](https://code.visualstudio.com/api/advanced-topics/remote-extensions)

In Restricted Mode, the custom editor is available after you trust the workspace through VS Code. [VS Code Workspace Trust guide](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)

## Explore a contact map

1. In **Heatmap**, select a **Stored resolution** and **Chromosome**. Each pixel shows the contacts between a pair of bins on that chromosome.
2. Set **Start** and **End** in base pairs, then select **Draw heatmap**. Coordinates start at zero and the end is exclusive. For example, chr19 from `12000000` to `14000000` spans 20 bins per axis at a stored resolution of 100 kb. The map includes whole bins that overlap the interval.
3. Use the **Zoom** slider above the heatmap. Hold **Ctrl** (**Cmd** on macOS) and scroll over the heatmap to zoom toward the pointer. Drag the zoomed map to pan, or choose **Reset view** to see the full region. Zoom magnifies the current map. Choose a finer stored resolution to see more detail if the file includes one.
4. Hover over a pixel to see its two genomic intervals and exact value. With the map focused, use the arrow keys to inspect bin pairs, **+** and **−** to zoom, or **Home** to reset the view.
5. Choose **Export PNG** to save the whole drawn region with its selected palette and color scale.

Use **Raw counts** to view the stored counts or **Balanced** to apply the file's default weights where available. Gray indicates missing values. Each map scales its colors to the maximum value in the displayed region, with **Logarithmic** and **Linear** scaling options.

The heatmap supports up to 512 display bins per axis. For a wider interval, shorten the interval, select a coarser stored resolution, or increase **Display bin size** for a fixed-bin map. A larger display bin must be a whole multiple of the stored bin size and sums raw counts. A display bin starts on a multiple of its size from the beginning of the chromosome and ends at the chromosome boundary if needed.

## Read metadata

Open **Metadata** to inspect the assembly, chromosome lengths, bin and pixel counts, balancing availability, and file attributes. Use **Filter chromosomes** to find a specific chromosome. **Stored pixels** counts the bin pairs recorded in the file. **Total contacts** sums their counts.

| Quantity | Compact display | Exact value |
| --- | --- | --- |
| Genomic length | 6.54 Mb | 6,540,390 bp |
| Contact count | 6.54M | 6,540,390 contacts |

The metadata tables retain exact values for checking and copying.

## Supported files

MCOOL Reader works in desktop VS Code 1.85 and later. It reads single-resolution `.cool` files and standard `.mcool` files with a `/resolutions` group. The heatmap displays one chromosome on both axes. Uncompressed and gzip-compressed datasets are supported. Files that require an HDF5 compression plugin may need a gzip copy. [Cooler format specification](https://cooler.readthedocs.io/en/latest/schema.html)

The source repository includes maintainer instructions in `PUBLISHING.md`. The bundled `h5wasm` reader was developed at the National Institute of Standards and Technology. [h5wasm project](https://github.com/usnistgov/h5wasm)

## Snaps
<img width="2088" height="1732" alt="image" src="https://github.com/user-attachments/assets/5f587eaa-1397-470d-981f-84480d584e53" />
<img width="2066" height="1736" alt="image" src="https://github.com/user-attachments/assets/e8465766-cda4-459d-923e-b31ed8938dee" />

