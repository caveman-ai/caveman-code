# Wallpaper asset pack

Full artwork lives here, outside the web and desktop build. The app bundles
small gallery thumbnails and the metadata in
`apps/web/src/state/wallpaper-library.json`. Each original image is published
under its content hash on `download.caveman.so/code/wallpapers/v1/` and fetched
only when selected. Existing immutable files are never deleted during upload.

`node scripts/publish-wallpapers.mjs` verifies file names, hashes, sizes,
formats, and credits. The Wallpaper library workflow verifies pull requests
and publishes changed packs from main using the existing downloads bucket.

Credits and license links are recorded per image in the catalog and shown
on gallery cards. The pack includes Super Visuals by Ahmed Hassan (CC BY
4.0), public-domain paintings, NASA imagery, and photographs under the
individual Creative Commons licenses listed in the catalog. Encoding,
resizing, and gallery thumbnail cropping are Caveman's changes. No creator
endorsement is implied; the app's software license adds no restrictions to
the artwork.

`edge.mjs` grants anonymous GET/HEAD canvas reads only under the wallpaper URL
prefix. Other downloads receive no new headers or storage access. Deploy that
route with `wrangler deploy --config wallpapers/wrangler.jsonc` using existing
Cloudflare authentication. The bucket's CORS configuration stays unchanged;
publishing uses the existing bucket-scoped object token. The publish job
verifies public image bytes and CORS after uploading.
