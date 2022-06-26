var frame = 0;
var scanline = 0;
var pixelOnFrame = 0;
var pixelOnScanline = 0;
var vblank = false;
var vblank_set = false;
var sprite0hit = false;
var spriteOverflow = false;
var addressLatch = false;

var empR = false;
var empG = false;
var empB = false;

var showSprites = false;
var showBG = false;
var maskSprites = false;
var maskBG = false;
var grayscale = false;

var ntIndex = 0;
var currentNtIndex = 0;
var vertical = false;
var spritesOnChr1000 = false;
var bgOnChr1000 = false;
var tallSprites = false;
var enableNmi = false;

var xScroll = 0;
var yScroll = 0;
//var currentXscroll = 0;
var currentY = 0;
var globalBgColor = 0; // palette change glitches

function ppuReset() {
	frame = 0;
	scanline = 0;
	pixelOnFrame = 0;
	pixelOnScanline = 0;
	sprite0hit = false;
	vblank = false;
	vblank_set = false;
	spriteOverflow = false;
	addressLatch = false;
	enableNmi = false;
}
function ppuAdvanceFrame(timestamp) {
	if (!shouldRenderNewFrame(timestamp)) {
		timing = window.requestAnimationFrame(ppuAdvanceFrame);
		return;
	}
	//apuFrameCount();
	
	frame++;
	scanline = -1;
	currentY = yScroll;
	globalBgColor = 0;
	currentNtIndex = ntIndex;
	pixelOnFrame = 0;
	pixelOnScanline = 0;
	sprite0hit = false;
	vblank = false;
	vblank_set = false;
	runPc();
}
var outputBuffer = new ArrayBuffer(256*256*4);
var outputBytes = new Uint8Array(outputBuffer);
var outputColorEdit = new Uint8ClampedArray(outputBuffer);
var outputColors = new Uint32Array(outputBuffer);
var scanlineSpriteBuffer = new Uint8Array(8 * 5);
var sbi = 0;
function ppuScanline() {
	
	scanline++;
	if (mmc5ScanlineIrqEnabled && scanline == irqCounter[2]) pendingIrq = true;
	
	if (scanline >= 240) return;
	var spriteHeight = tallSprites ? 16 : 8;
	sbi = -5;
	
	for (i = 0; i < 256; i += 4) {

		var yOffset = scanline-oamMemory[i]-1;
		if (yOffset < 0 || yOffset >= spriteHeight) continue;

		var spriteIndex = oamMemory[i + 1];
		
		if (oamMemory[i + 2] & 0x80) yOffset = spriteHeight - 1 - yOffset; // flipY
		if (yOffset > 7) yOffset += 8; // skip second 8 bytes of a tile

		if (tallSprites && (spriteIndex & 1) != 0) {
			yOffset += ((spriteIndex & 0xFE) | 0x100) << 4;
		}
		else {
			yOffset += spriteIndex << 4;
		}
		// Save as much info as possible in sprite buffer to speed up the ppuPixel function.
		// The NES does something almost similar when evaluating sprites, so it shouldn't cause compatibility problems, aside from games that actually rely on corrupting sprite reads(?)
		sbi += 5;
		scanlineSpriteBuffer[sbi] = i; // reference
		scanlineSpriteBuffer[sbi+1] = oamMemory[i + 3]; // X
		scanlineSpriteBuffer[sbi+2] = ppuMemory[spriteChrIndex | yOffset];// << 3;
		scanlineSpriteBuffer[sbi+3] = ppuMemory[spriteChrIndex | yOffset + 8];// << 3;
		scanlineSpriteBuffer[sbi+4] = 0;
		if (sbi == 35) break; // 8 sprite limit
		
		if (mapperListener) {
			var map2 = mapperListener[spriteChrIndex | yOffset + 8];
			if (map2) map2();
		}
	}

	pixelOnScanline = 0;
	currentNtIndex = (currentNtIndex & 2) | (ntIndex & 1); // Set horizontal nametable index at the beginning of scanline

}

var ntBuffer = new Uint8Array(8);
var ntBufferCount = 0;

var bgChrIndex = 0;
var spriteChrIndex = 0;
function ppuPixel() {
	
	if (pixelOnScanline > 255) {
		if (pixelOnScanline == 256) {
			
			if (mapperListener) {
				// Special hotfix for Punch-Out until the BG buffering routine is made more accurate
				var ntRef = nametables[currentNtIndex];
				var x = pixelOnScanline + xScroll + 8;
				if (x & 0x100) {
					x &= 0xFF;
					ntRef = nametables[currentNtIndex^1];
				}
				var tileIndex = ((currentY & 0xF8) << 2) | (x >> 3);
				var tileOffset = bgChrIndex | (ntRef[tileIndex] << 4) | (currentY & 7);
				var map2 = mapperListener[tileOffset + 8];
				if (map2) map2();
			}
			
			globalBgColor = 0;
			currentY++;
			if (currentY == 256) currentY = 0;
			if (currentY == 240) {
				currentY = 0;
				currentNtIndex ^= 2;
			}
		}
		if (pixelOnScanline == 260) {
			if (irqCounter[0] == 0) irqCounter[0] = irqCounter[1]; // IRQ reload
			else if (scanline < 240 && (showBG || showSprites)) {
				irqCounter[0]--;
				if (scanlineIrqEnabled && irqCounter[0] == 0) {
					currentCycleCount++; // TODO: For some reason adding a cycle here fixes all timing issues for MMC3 splits. I need to find out where it comes from
					pendingIrq = true;
				}
			}
		}
		pixelOnScanline++;
		
if (scanline == 261 && pixelOnScanline == 301) {
	frameEnded = true; // timing fix
}

		
		if (pixelOnScanline == 341) pixelOnScanline = 0;
		return;
	}
	
	
	if (pixelOnScanline == 0) ppuScanline(); // Individual pixel mode
	if (pixelOnScanline == 1 && scanline == 241) ppuIsVblank();
	if (scanline == 262) {
		frameEnded = true; // TODO: Find out why frames are 13-60 pixels too long
	}
	if (scanline >= 240) {
		pixelOnScanline++;
		return;
	}
	
	var bgOnTop = false;
	var color = 0;
	var palette = 0;
	var potentialHit = false;

	if (showSprites && (pixelOnScanline > 7 || !maskSprites)) {
		for (var i = sbi; i >= 0; i -= 5) {
			if (scanlineSpriteBuffer[i+1] != pixelOnScanline) continue;
			var tileX = scanlineSpriteBuffer[i+4];
			if (tileX == 8) continue;
			var attribute = oamMemory[scanlineSpriteBuffer[i] + 2];
			if (attribute & 0x40) tileX = 7 - tileX; // flipX
			var spriteColor = getChrColor(scanlineSpriteBuffer[i+2], scanlineSpriteBuffer[i+3], tileX);
			if (spriteColor) {
				color = spriteColor;
				palette = 4 | (attribute & 3);
				bgOnTop = (attribute & 0x20) != 0;
				if (scanlineSpriteBuffer[i] == 0) potentialHit = true;
			}
			
			scanlineSpriteBuffer[i+1]++;
			scanlineSpriteBuffer[i+4]++;
		}
	}

	var x = pixelOnScanline + xScroll;
	var tileX = (x & 7);

	//if (ntBufferCount == 0 && showBG) { // TODO: buffer two tiles ahead independent of fine scroll
	if ((tileX == 0 | pixelOnScanline == 0) && showBG) {
		var ntRef = nametables[currentNtIndex];
		var attrRef = attributetables[currentNtIndex];
		
		if (x & 0x100) {
			x &= 0xFF;
			ntRef = nametables[currentNtIndex^1];
			attrRef = attributetables[currentNtIndex^1];
		}

		var tileIndex = ((currentY & 0xF8) << 2) | (x >> 3);
		var tileOffset = bgChrIndex | (ntRef[tileIndex] << 4) | (currentY & 7);
		ntBuffer[1] = attrRef[((tileIndex >> 4) & 0b11111000) | ((tileIndex >> 2) & 7)];
		if (tileIndex & 0b10) ntBuffer[1] >>= 2;
		if (tileIndex & 0b1000000) ntBuffer[1] >>= 4;
		ntBuffer[1] &= 3;
		ntBuffer[2] = bgChrMemory[tileOffset];
		ntBuffer[3] = bgChrMemory[tileOffset+8];
		
		if (mapperListener) {
			var map2 = mapperListener[tileOffset + 8];
			if (map2) map2();
		}
	}
	ntBufferCount = (ntBufferCount + 1) & 7;
	
	if (showBG && (pixelOnScanline > 7 || !maskBG)) {
		var bgColor = getChrColor(ntBuffer[2], ntBuffer[3], tileX);
		if (bgColor && potentialHit) sprite0hit = true;
		if (!color || bgColor && bgOnTop) {
			color = bgColor;
			palette = ntBuffer[1];
		}
	}

	var paletteColor = color ? ppuPalettes[palette * 4 + color] : ppuPalettes[globalBgColor];
	if (grayscale) paletteColor &= 0x30;
	outputColors[pixelOnFrame] = fullPalette[paletteColor];
	
	if (empR) {
		outputColorEdit[pixelOnFrame*4] *= 1.1;
		outputColorEdit[pixelOnFrame*4+1] *= 0.9;
		outputColorEdit[pixelOnFrame*4+2] *= 0.9;
	}
	if (empG) {
		outputColorEdit[pixelOnFrame*4] *= 0.9;
		outputColorEdit[pixelOnFrame*4+1] *= 1.1;
		outputColorEdit[pixelOnFrame*4+2] *= 0.9;
	}
	if (empB) {
		outputColorEdit[pixelOnFrame*4] *= 0.9;
		outputColorEdit[pixelOnFrame*4+1] *= 0.9;
		outputColorEdit[pixelOnFrame*4+2] *= 1.1;
	}
	pixelOnFrame++;
	pixelOnScanline++;
}
function getChrColor(byte1, byte2, tileX) {
	switch (tileX) {
		case 0:
			return ((byte1 >> 7) & 0x01) | ((byte2 >> 6) & 0x02);
		case 1:
			return ((byte1 >> 6) & 0x01) | ((byte2 >> 5) & 0x02);
		case 2:
			return ((byte1 >> 5) & 0x01) | ((byte2 >> 4) & 0x02);
		case 3:
			return ((byte1 >> 4) & 0x01) | ((byte2 >> 3) & 0x02);
		case 4:
			return ((byte1 >> 3) & 0x01) | ((byte2 >> 2) & 0x02);
		case 5:
			return ((byte1 >> 2) & 0x01) | ((byte2 >> 1) & 0x02);
		case 6:
			return ((byte1 >> 1) & 0x01) | ((byte2) & 0x02);
		case 7:
			return ((byte1) & 0x01) | ((byte2 << 1) & 0x02);
	}
}
function ppuIsVblank() {
	
	renderFrame();
	
	vblank = true;
	vblank_set = true;
	pullNmi();
}

function pullNmi() {
	if (!enableNmi) return;
	pendingNmi = true;
}

var lastWrite = 0;
function ppuCtrl(value) {
	lastWrite = value;
	
	ntIndex = (value & 3);
	vertical = (value & 4) != 0;
	spritesOnChr1000 = (value & 8) != 0;
	bgOnChr1000 = (value & 16) != 0;
	tallSprites = (value & 32) != 0;
	//TODO: ??? = (value & 64) != 0;
	enableNmi = (value & 128) != 0;
	
	bgChrIndex = bgOnChr1000 ? 0x1000 : 0;
	spriteChrIndex = (spritesOnChr1000 && !tallSprites) ? 0x1000 : 0;
}
function ppuMask(value) {
	lastWrite = value;
	
	grayscale = (value & 1);
	maskBG = !(value & 2);
	maskSprites = !(value & 4);
	showBG = (value & 8);
	showSprites = (value & 16);
	empR = (value & 32);
	empG = (value & 64);
	empB = (value & 128);
}
function ppuScroll(value) {
	if (!addressLatch) {
		xScroll = value;
		addressBytes[0] = (addressBytes[0] & 0b11100000) | (value >> 3);
	}
	else {
		yScroll = value;
		address[0] = (address[0] & 0b110000011111) | ((value & 0b11111000) << 2);
		addressBytes[1] |= (value & 7) << 4;
	}
	addressLatch = !addressLatch;
}
var addressBuffer = new ArrayBuffer(2);
var addressBytes = new Uint8Array(addressBuffer);
var address = new Uint16Array(addressBuffer);
var writeAddressBuffer = new ArrayBuffer(2);
var writeAddressBytes = new Uint8Array(writeAddressBuffer);
var writeAddress = new Uint16Array(writeAddressBuffer);

function ppuAddr(value) {
	if (addressLatch) {
		addressBytes[0] = value;
		setWriteAddress(address[0]);
	}
	else {
		ntIndex = (value >> 2) & 3;
		addressBytes[1] = value & 0x3f; // PPU address is a 14 bit register
	}
	addressLatch = !addressLatch;
}
function ppuDataWrite(value) {
	if (writeAddress[0] >= 0x2000 && writeAddress[0] < 0x3F00) {
		// Mirroring
		nametables[(writeAddress[0] >> 10) & 3][writeAddress[0] & 0x3FF] = value;
	}
	else if (writeAddress[0] >= 0x3F00) {
		var effectiveAddress = writeAddress[0] & 0x3f1f;
		if (effectiveAddress == 0x3F10) effectiveAddress = 0x3F00;
		ppuMemory[effectiveAddress] = value & 0x3f;
	}
	else mapChrWrite(writeAddress[0], value);
		
	setWriteAddress(writeAddress[0] + (vertical ? 32 : 1));
}
function setWriteAddress(value) {
	writeAddress[0] = value;
	// Simulates the register "conflicts" when writing to PPUADDR mid-frame
	// TODO: Would probably be a lot better to just replicate the W and T registers directly
	currentY = ((writeAddress[0] >> 2) & 0xF8) | (writeAddressBytes[1] >> 4);
	currentNtIndex = (writeAddressBytes[1] >> 2) & 3;
	globalBgColor = 0;
	writeAddress[0] &= 0x3FFF;
	if (writeAddress[0] >= 0x3F00) globalBgColor = writeAddress[0] & 31;
}

var oamAddressBuffer = new ArrayBuffer(2);
var oamAddressBytes = new Uint8Array(oamAddressBuffer);
var oamAddress = new Uint16Array(oamAddressBuffer);
function ppuOamDma(value) {
	oamAddressBytes[1] = value;
	oamMemory.set(cpuMemory.subarray(oamAddress[0], oamAddress[0] + 0x100), 0);
	currentCycleCount += 513;
}

var readBuffer = 0;
function ppuDataRead() {
	var result = readBuffer;
	if (writeAddress[0] >= 0x2000 && writeAddress[0] < 0x3F00) { // Nametables
		// Mirroring
		readBuffer = nametables[(writeAddress[0] >> 10) & 3][writeAddress[0] & 0x3FF];
	}
	else if (writeAddress[0] < 0x3F00) { // CHR
		readBuffer = mapChrRead(writeAddress);
	}
	else { // Palette data
		readBuffer = ppuMemory[writeAddress[0]];
		result = ppuMemory[writeAddress[0]];
	}
	setWriteAddress(writeAddress[0] + (vertical ? 32 : 1));
	return result;
}


function ppuReadStatus() {
	var returnValue = (lastWrite & 31) | (vblank_set ? 0x80 : 0) | (sprite0hit ? 0x40 : 0) | (spriteOverflow ? 0x20 : 0);
	vblank_set = false;
	addressLatch = false;
	return returnValue;
}
function setPpuRegisters() {
	hwRegisters[0x2000] = new HwRegister(null, ppuCtrl);
	hwRegisters[0x2001] = new HwRegister(null, ppuMask);
	hwRegisters[0x2002] = new HwRegister(ppuReadStatus);
	hwRegisters[0x2003] = new HwRegister();
	hwRegisters[0x2004] = new HwRegister();
	hwRegisters[0x2005] = new HwRegister(null, ppuScroll);
	hwRegisters[0x2006] = new HwRegister(null, ppuAddr);
	hwRegisters[0x2007] = new HwRegister(ppuDataRead, ppuDataWrite);
	hwRegisters[0x4014] = new HwRegister(null, ppuOamDma);
}

var ntBuffer = new ArrayBuffer(512*512*4);
var ntBytes = new Uint8Array(ntBuffer);
//var ntClampedBytes = new Uint8ClampedArray(ntBuffer);
var ntColors = new Uint32Array(ntBuffer);

var spriteBuffer = new ArrayBuffer(128*256*4);
var spriteBytes = new Uint8Array(spriteBuffer);
var spriteColors = new Uint32Array(spriteBuffer);


var vMirroring = false;
var nametables = [];
var attributetables = [];


function bufferNametable() {
	
	for (var ntI = 0; ntI < 4; ntI++) {
		var x = 0; // pixel offset, not y coordinate
		switch (ntI) {
			case 1:
				x = 256;
				break;
			case 2:
				x = 512*240;
				break;
			case 3:
				x = 512*240 + 256;
		}
		var ntRef = nametables[ntI];
		var attrRef = attributetables[ntI];
		
		for (var i = 0; i < 0x3C0; i++) {
			//var x = (i & 31) << 3;
			var attrOffset = ((i >> 4) & 0b11111000) | ((i >> 2) & 7);
			var tileOffset = ntRef[i] * 64 + (bgOnChr1000 ? 0x4000 : 0);
			var attribute = attrRef[attrOffset];
			if (i & 0b10) attribute >>= 2;
			if (i & 0b1000000) attribute >>= 4;
			var palette = bgPalettes[attribute & 3];

			for (var j = 0; j < 8; j++) {
				ntColors[x + j] = palette[tiles[tileOffset + j]];
				ntColors[x + j + 0x200] = palette[tiles[tileOffset + j + 8]];
				ntColors[x + j + 0x400] = palette[tiles[tileOffset + j + 16]];
				ntColors[x + j + 0x600] = palette[tiles[tileOffset + j + 24]];
				ntColors[x + j + 0x800] = palette[tiles[tileOffset + j + 32]];
				ntColors[x + j + 0xA00] = palette[tiles[tileOffset + j + 40]];
				ntColors[x + j + 0xC00] = palette[tiles[tileOffset + j + 48]];
				ntColors[x + j + 0xE00] = palette[tiles[tileOffset + j + 56]];
			}
			
			x += 8;
			if ((x & 0xFF) == 0) x += 0x200 * 7 + 0x100; // Skip next door nametables
		}
	}
}
var indexPalette = new Uint32Array(4);
indexPalette[0] = 0x00000000;
indexPalette[1] = 0xff0000ff;
indexPalette[2] = 0xff00ff00;
indexPalette[3] = 0xffff0000;

function bufferSprites() {
	var palette = bgPalettes[0];
	var offset = 0;
	var tileOffset = 0;
	var x = 0;
	for (var i = 0; i < 512; i++) {
		offset = x;
		for (var j = 0; j < 8; j++) {
			spriteColors[offset] = palette[tiles[tileOffset]];
			spriteColors[offset+1] = palette[tiles[tileOffset+1]];
			spriteColors[offset+2] = palette[tiles[tileOffset+2]];
			spriteColors[offset+3] = palette[tiles[tileOffset+3]];
			spriteColors[offset+4] = palette[tiles[tileOffset+4]];
			spriteColors[offset+5] = palette[tiles[tileOffset+5]];
			spriteColors[offset+6] = palette[tiles[tileOffset+6]];
			spriteColors[offset+7] = palette[tiles[tileOffset+7]];
			offset += 128;
			tileOffset += 8;
		}
		x += 8;
		if ((x & 0x7F) == 0) x += 128 * 7;
	}
}
function renderFrame() {

		if (debug) {
			decompressChr();
			preparePalettes();
			bufferNametable();
			bufferSprites();
		}
		
		if (debug && glNt) {
			glNt.Clear(paletteBytes[bgColor] / 255, paletteBytes[bgColor+1] / 255, paletteBytes[bgColor+2] / 255);
			glNt.UpdateTextureData('nt', ntBytes);
			glNt.SpriteBatch();
			glNt.DrawSprite('nt', 0, 480, 0, 0, 512, 480);
			glNt.Render();
		}
		if (debug && glChr) {
			glChr.Clear(paletteBytes[bgColor] / 255, paletteBytes[bgColor+1] / 255, paletteBytes[bgColor+2] / 255);
			glChr.UpdateTextureData('chr', spriteBytes);
			glChr.SpriteBatch();
			glChr.DrawSprite('chr', 0, 256, 0, 0, 128, 256);
			glChr.Render();
		}

		var backBuffer;
		if (useGl) {
			context.UpdateTextureData('output', outputBytes);
			context.Clear(paletteBytes[bgColor] / 255, paletteBytes[bgColor+1] / 255, paletteBytes[bgColor+2] / 255);
			context.DrawBuffer();
			backBuffer = context.Canvas();
			output.imageSmoothingEnabled = output.webkitImageSmoothingEnabled = output.mozImageSmoothingEnabled = true;
		}
		else {
			context.putImageData(context.imageData, 0, 0);
			backBuffer = context.canvas;
			output.imageSmoothingEnabled = output.webkitImageSmoothingEnabled = output.mozImageSmoothingEnabled = false;
		}
		output.drawImage(backBuffer, 0, 0, backBuffer.width, backBuffer.height, 0, 0, output.canvas.width, output.canvas.height);
}
var tileBuffer = new ArrayBuffer(128*128*2);
var tiles = new Uint8Array(tileBuffer);
var tiles0 = new Uint8Array(tileBuffer, 0, 128*128);
var tiles1 = new Uint8Array(tileBuffer, 128*128);
function decompressChr() {
	var tileIndex = 0;
	for (var i = 0; i < 0x2000; i += 8) {
		
		for (var j = 0; j < 8; j++) {
			tiles[tileIndex] = (mapChrRead(i) & 0x80) >> 7 | (mapChrRead(i+8) & 0x80) >> 6
			tiles[tileIndex+1] = (mapChrRead(i) & 0x40) >> 6 | (mapChrRead(i+8) & 0x40) >> 5
			tiles[tileIndex+2] = (mapChrRead(i) & 0x20) >> 5 | (mapChrRead(i+8) & 0x20) >> 4
			tiles[tileIndex+3] = (mapChrRead(i) & 0x10) >> 4 | (mapChrRead(i+8) & 0x10) >> 3
			tiles[tileIndex+4] = (mapChrRead(i) & 0x08) >> 3 | (mapChrRead(i+8) & 0x08) >> 2
			tiles[tileIndex+5] = (mapChrRead(i) & 0x04) >> 2 | (mapChrRead(i+8) & 0x04) >> 1
			tiles[tileIndex+6] = (mapChrRead(i) & 0x02) >> 1 | (mapChrRead(i+8) & 0x02)
			tiles[tileIndex+7] = (mapChrRead(i) & 0x01) | (mapChrRead(i+8) & 0x01) << 1

			tileIndex += 8;
			i++
		}
	}
}
var paletteBuffer = new ArrayBuffer(4*4*4*2);
var palettes = new Uint32Array(paletteBuffer);
var bgPalettes = [
	new Uint32Array(paletteBuffer, 0, 4),
	new Uint32Array(paletteBuffer, 4*4, 4),
	new Uint32Array(paletteBuffer, 8*4, 4),
	new Uint32Array(paletteBuffer, 12*4, 4)
];
var spritePalettes = [
	new Uint8Array(paletteBuffer, 16*4, 16),
	new Uint8Array(paletteBuffer, 20*4, 16),
	new Uint8Array(paletteBuffer, 24*4, 16),
	new Uint8Array(paletteBuffer, 28*4, 16)
];
var bgColor = 0;
function preparePalettes() {
	for (var i = 0; i < 0x20; i++) {
		palettes[i] = fullPalette[ppuPalettes[i]];
		if (!(i & 3 | 0b00)) palettes[i] = 0x00000000;
	}
	bgColor = ppuPalettes[0] * 4;
}


var paletteData = window.atob('ZmZmACqIFBKnOwCkXAB+bgBAbAYAVh0AMzUAC0gAAFIAAE8IAEBNAAAAAAAAAAAAra2tFV/ZQkD/dSf+oBrMtx57tTEgmU4Aa20AOIcADJMAAI8yAHyNAAAAAAAAAAAA//7/ZLD/kpD/xnb/82r//m7M/oFw6p4ivL4AiNgAXOQwReCCSM3eT09PAAAAAAAA//7/wN//09L/6Mj/+8L//sTq/szF99il5OWUz++WvfSrs/PMtevyuLi4AAAAAAAA');

var paletteBuffer = new ArrayBuffer(0x40*4);
var fullPalette = new Uint32Array(paletteBuffer);
var paletteBytes = new Uint8Array(paletteBuffer);
for (i = 0; i < 0x40; i++) {
	paletteBytes[i*4+3] = 0xFF;
	paletteBytes[i*4+2] = paletteData.charCodeAt(i*3+2);
	paletteBytes[i*4+1] = paletteData.charCodeAt(i*3+1);
	paletteBytes[i*4+0] = paletteData.charCodeAt(i*3+0);
}
