New-Item -ItemType Directory -Force extension\media
New-Item -ItemType Directory -Force receiver\lib
npm init -y
npm install qrcode pako jsqr
Copy-Item node_modules\qrcode\build\qrcode.min.js extension\media\
Copy-Item node_modules\pako\dist\pako.min.js extension\media\
Copy-Item node_modules\pako\dist\pako.min.js receiver\lib\
Copy-Item node_modules\jsqr\dist\jsQR.js receiver\lib\
Remove-Item -Recurse -Force node_modules
Remove-Item package.json, package-lock.json
