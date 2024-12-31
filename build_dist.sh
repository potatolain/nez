#!/bin/bash
set -e

# This is a quick script that creates a static version of this site/emulator that can run without PHP.
# Run it in the same folder as `index.php`, and it will create a `dist` folder that you can upload to s3, or 
# put in git to host directly using Github's sites feature. It requires PHP be installed on the host system.

# This and `build_dist.bat` are identical in functionality - use the .bat on windows, and the .sh on other
# operating systems.


command -v php >/dev/null 2>&1 || { echo "The php command is required to build static assets."; exit 1; }

mkdir dist || echo "Dist dir already exists; continuing..."
php -d display_errors=0 index.php > dist/index_untouched.html
php -d display_errors=0 index_embed.php > dist/index_embed_untouched.html
php -d display_errors=0 index_embed_ecard.php > dist/index_embed_ecard_untouched.html
php -d display_errors=0 emulatorscript.php > dist/emulatorscript.js
php -d display_errors=0 -r "echo str_replace('emulatorscript.php', 'emulatorscript.js', file_get_contents('./dist/index_untouched.html'));" > dist/index.html
php -d display_errors=0 -r "echo str_replace('emulatorscript.php', 'emulatorscript.js', file_get_contents('./dist/index_embed_untouched.html'));" > dist/index_embed.html
php -d display_errors=0 -r "echo str_replace('emulatorscript.php', 'emulatorscript.js', file_get_contents('./dist/index_embed_ecard_untouched.html'));" > dist/index_embed_ecard.html
cp *.svg dist
cp *.glsl dist
cp *.png dist
cp *.css dist
cp config.js dist