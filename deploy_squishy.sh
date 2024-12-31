./build_dist.sh

aws s3 cp --recursive dist/ s3://squishy-ecard.nes.science/
aws s3 cp dist/index_embed_ecard.html s3://squishy-ecard.nes.science/index.html
aws s3 cp config-squishy.js s3://squishy-ecard.nes.science/config.js