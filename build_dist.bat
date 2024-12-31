REM This is a quick script that creates a static version of this site/emulator that can run without PHP.
REM Run it in the same folder as `index.php`, and it will create a `dist` folder that you can upload to s3, or 
REM put in git to host directly using Github's sites feature. It requires PHP be installed on the host system.

REM This and `build_dist.sh` are identical in functionality - use the .bat on windows, and the .sh on other
REM operating systems.

WHERE php >nul 2>nul 
IF %ERRORLEVEL% NEQ 0 (
    echo PHP needs to be installed and available on your path to build static assets.
    exit
)

mkdir dist
php -d display_errors=0 index.php > dist\index_untouched.html
php -d display_errors=0 index_embed.php > dist\index_embed_untouched.html
php -d display_errors=0 index_embed_ecard.php > dist\index_embed_ecard_untouched.html
php -d display_errors=0 emulatorscript.php > dist\emulatorscript.js
php -d display_errors=0 -r "echo str_replace('emulatorscript.php', 'emulatorscript.js', file_get_contents('./dist/index_untouched.html'));" > dist\index.html
php -d display_errors=0 -r "echo str_replace('emulatorscript.php', 'emulatorscript.js', file_get_contents('./dist/index_embed_untouched.html'));" > dist\index_embed.html
php -d display_errors=0 -r "echo str_replace('emulatorscript.php', 'emulatorscript.js', file_get_contents('./dist/index_embed_ecard_untouched.html'));" > dist\index_embed_ecard.html
copy *.svg dist
copy *.glsl dist
copy *.png dist
copy *.css dist
copy config.js dist
copy ereader_wrapper.html dist