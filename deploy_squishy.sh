./build_dist.sh

aws s3 cp --recursive dist/ s3://squishy-ecard.nes.science/
aws s3 cp config-squishy.js s3://squishy-ecard.nes.science/config.js
aws s3 cp dist/ereader_wrapper.html s3://squishy-ecard.nes.science/index.html