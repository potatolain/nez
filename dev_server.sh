npx nodemon . --exec "build_dist.sh && sleep 1 && npx http-server dist" --watch . -e *.js,*.php,*.css,*.html --ignore dist
