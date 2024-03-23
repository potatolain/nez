
// TODO: Color emphasis, fix timing(?) issues (space soviets), MMC5, VRC6, performance optimization, FDS?, PAL support?

window.emu = (function() {
	
	var delay = 1.0 / (1000.0 / 60.0);
	var time = null;
	
	function shouldRenderNewFrame(timestamp) {
		if (time === null)
			time = timestamp;
		var seg = Math.floor((timestamp - time) * delay);
		if (seg <= frame) {
			return false;
		}

		return true;
	}

	var preloadedData = {};
	var cart = {
		prg: null, chr: null
	}
	var oamMemoryBuffer = new ArrayBuffer(0x100);
	var oamMemory = new Uint8Array(oamMemoryBuffer);

	var cpuMemoryBuffer = new ArrayBuffer(0x10000);
	var cpuMemory = new Uint8Array(cpuMemoryBuffer);
	var stack = new Uint8Array(cpuMemoryBuffer, 0x100, 0x100);
	
	var ppuMemoryBuffer = new ArrayBuffer(0x4000);
	var ppuMemory = new Uint8Array(ppuMemoryBuffer);
	var nameTableSources = [
		new Uint8Array(ppuMemoryBuffer, 0x2000, 0x400),
		new Uint8Array(ppuMemoryBuffer, 0x2400, 0x400),
		new Uint8Array(ppuMemoryBuffer, 0x2800, 0x400),
		new Uint8Array(ppuMemoryBuffer, 0x2C00, 0x400)
	];
	var attrSources = [
		new Uint8Array(ppuMemoryBuffer, 0x23C0, 0x40),
		new Uint8Array(ppuMemoryBuffer, 0x27C0, 0x40),
		new Uint8Array(ppuMemoryBuffer, 0x2BC0, 0x40),
		new Uint8Array(ppuMemoryBuffer, 0x2FC0, 0x40)
	];
	var ppuPalettes = new Uint8Array(ppuMemoryBuffer, 0x3F00, 0x20);
	var bgChrMemory = new Uint8Array(ppuMemoryBuffer, 0, 0x2000);
		
	var cpuBuffer = new ArrayBuffer(10);
	var cpuRegisters = new Uint8Array(cpuBuffer, 0, 4);
	var pcByte = new Uint8Array(cpuBuffer, 4, 2);
	var pc = new Uint16Array(cpuBuffer, 4, 1);
	var flags = new Uint8Array(cpuBuffer, 6, 1); // don't use?
	
	var hwRegisters = {};

	var cycleCounts = new Float32Array(3);
	
	var c = false;
	var n = false;
	var z = false;
	var v = false;
	var interruptFlag = false;
	
	var loaded = false;
	var mappers = [];
	
	var mapRead = [];
	var mapWrite = [];
	var mapChrRead, mapChrWrite;

/*
Support for features with browser prefixes and other strange quirks... fixes weird shortcomings in:
- safari on ios

*/

// Safari (all versions) still prefix this for reasons unknown.. interface is the same, so just polyfill it.
if (!window.AudioContext && window.webkitAudioContext) {
    window.AudioContext = window.webkitAudioContext;
}

// Disable the pinch-to-zoom behavior on ios. As nice as it is for reading, it's extremely easy to trigger this
// while trying to play a game, and that ends up ruining the experience.
document.addEventListener('gesturestart', function(e) {
    e.preventDefault();
    document.body.style.zoom = 1;
});

document.addEventListener('gesturechange', function(e) {
    e.preventDefault();
    document.body.style.zoom = 1;
});

document.addEventListener('gestureend', function(e) {
    e.preventDefault();
    document.body.style.zoom = 1;
});
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
var masterVolumeValue = 0.15;
const enableAudioEmulation = true;
function SetMasterVolume(value) {
	masterVolumeValue = value;
	Unmute();
}
function Mute() {
	if (masterVolume) masterVolume.gain.setValueAtTime(0, audio.currentTime);	
}
function Unmute() {
	if (masterVolume) masterVolume.gain.setValueAtTime(masterVolumeValue, audio.currentTime);
}

var audio;
var masterVolume;

var pulse1 = {
	oscillator: null,
	haltLengthCounter: false,
	constantFlag: false,
	dutyCycle: 0,
	volume: 0
};

var pulse2 = {
	oscillator: null,
	haltLengthCounter: false,
	constantFlag: false,
	dutyCycle: 0,
	volume: 0
};
var triangle = {};
var noise = {};
var dmc = {};


var NewApu = (function() {

	var running = false;

	var pulseCycles = [[0,1,0,0,0,0,0,0],[0,1,1,0,0,0,0,0],[0,1,1,1,1,0,0,0],[1,0,0,1,1,1,1,1]];
	var triangleCycle = [15, 14, 13, 12, 11, 10,  9,  8,  7,  6,  5,  4,  3,  2,  1,  0, 0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15];
	var bufferSize = 1024;

	var mixer;
	var wave, ctx;
	
	function initAudio() {
		if (audio || !enableAudioEmulation) return;
		
		audio = new AudioContext({sampleRate: 44100});

		//var compressor = audio.createDynamicsCompressor();
		masterVolume = audio.createGain();
		masterVolume.gain.setValueAtTime(masterVolumeValue, audio.currentTime);
		mixer = audio.createScriptProcessor(bufferSize, 0, 1);

		masterVolume.connect(audio.destination);
		//compressor.connect(masterVolume);
		//mixer.connect(masterVolume);
		//mixer.connect(audio.destination);
		mixer.connect(masterVolume);

		clockStep = 1789773 / 2 / audio.sampleRate; // NES clock frequency / 2 = APU sample rate
clockStep *= 0.97;
		//mixer.onaudioprocess = clockToOutput;
		mixer.onaudioprocess = resample;

		initChannel(pulse1);
		initChannel(pulse2);
		initChannel(triangle);
		
		noise.lengthCounter = 0;
		
		dmc.load = 0;
		dmc.loop = false;
		dmc.frequency = 0;
		dmc.timer = 0;
		dmc.address = 0;
		dmc.bytesRemaining = 0;
		dmc.currentByte = 0;
		dmc.shiftPointer = 0;
		dmc.length = 0;
		dmc.sample = 0;
		
		if (debug) {
			wave = new Float32Array(bufferSize);
			ctx = document.createElement('canvas').getContext('2d');
			ctx.canvas.width = 300;
			ctx.canvas.height = 50;
			ctx.canvas.style.width = "300px";
			output.canvas.parentNode.appendChild(ctx.canvas);
		}
		
		// Trigger a sound on IOS after a touch, which should allow us to start playing audio when the rom is ready.
		var oscillator = audio.createOscillator();
		oscillator.frequency.value = 400;
		oscillator.connect(audio.destination);
		oscillator.start(0);
		oscillator.stop(0); 
		

	}

	var npulse1 = {
		cycle: 2,
		pointer: 0,
		timer: 0,
		sample: 0
	};
	var npulse2 = {
		cycle: 2,
		pointer: 0,
		timer: 0,
		sample: 0
	};
	var ntriangle = {
		pointer: 0,
		timer: 0,
		sample: 0
	};
	var nnoise = {
		shiftRegister: 1,
		timer: 0,
		sample: 0
	}
	
	var counting = 0;

	function updateWaveform() {
		var c = ctx;
		c.clearRect(0,0,300,50);
		c.strokeStyle = "#ffffff";
		c.beginPath()
		c.moveTo(0, (-wave[0] * 10) + 50);
		for (var i = 1; i < wave.length; i++) {
			c.lineTo((i / wave.length) * 300, (-wave[i] * 10) + 50);
		}
		c.stroke();
	}
	
	// More accurate, but doesn't match output rate due to emulation, so will course clicks and/or lag
	var buffer = new Float32Array(bufferSize * 10);
	var bufferPointer = 100;
	var readPointer = 0;
	var bufferLength = 0;
	var bufferStep;
	function resample(e) {
		if (!running) return;
		if (bufferLength < 400) {
			//console.log('buffer underrun');
			return; // extreme underflow, in case of performance issues or the tab went into the background, we just want to skip this update
		}
		var output = e.outputBuffer.getChannelData(0);
		var l = Math.min(bufferLength, output.length);
		for (var i = 0; i < l; i++) {
			//output[i] = Math.tanh(buffer[readPointer] / (15*3));
			output[i] = buffer[readPointer];
			readPointer++;
			if (readPointer == buffer.length) readPointer = 0;
		}
		l = output.length;
		for (var i = bufferLength; i < l; i++) {
			asyncTick(clockStep);
			//output[i] = Math.tanh(sample / (15*3)); // 15 = sequencer "full" volume
			output[i] = sample;
		}
		bufferLength = Math.max(0, bufferLength - output.length);

		if (debug) {
			for (var i = 0; i < output.length; i++) wave[i] = output[i];
			updateWaveform();
		}
	}
	
	// Inaccurate, and might cause precise timing issues, but prevents buffer underflow
	var sample = 0; // mixed sample from all 5 channels
	var clockStep = 1789773 / 2 / 48000; // NES clock frequency / 2 = APU sample rate
	function clockToOutput(e) {
		if (!running) return;

		var output = e.outputBuffer.getChannelData(0);
		var l = output.length;
		for (var i = 0; i < l; i++) {
			asyncTick(clockStep);
			output[i] = sample / (15); // 15 = sequencer "full" volume
		}
		if (debug) {
			for (var i = 0; i < output.length; i++) wave[i] = output[i];
			updateWaveform();
		}
	}
	
	// APU clock updates:
	function updatePulse(channel, ref) {
		if (!ref.frequency) return;
		channel.timer -= click;
		while (channel.timer < 0) {
			channel.timer += ref.frequency;
			channel.pointer = (channel.pointer + 1) & 7;
		}
		var duty = ref.dutyCycle;
		channel.sample = ref.lengthCounter && pulseCycles[duty][channel.pointer] ? (ref.constantFlag ? ref.volume : ref.decay) : 0;
		//channel.sample >>= 1;
	}
	function updateTriangle(channel, ref) {
		if (!ref.frequency) return;
		channel.timer -= click + click;
		while (channel.timer < 0) {
			channel.timer += ref.frequency;
			channel.pointer = (channel.pointer + 1) & 31;
		}
		channel.sample = ref.lengthCounter && ref.linearCounter ? triangleCycle[channel.pointer] : 0;
	}
	function updateNoise(channel, ref) {
		if (!ref.frequency) return;
		channel.timer -= click;
		while (channel.timer < 0) {
			channel.timer += ref.frequency;
			var feedback = (channel.shiftRegister & 1) ^ ((channel.shiftRegister >> ref.mode) & 1);
			channel.shiftRegister >>= 1;
			if (feedback) channel.shiftRegister |= 0b100000000000000;
			channel.high = channel.shiftRegister & 1;
		}
		channel.sample = (ref.lengthCounter && channel.high) ? (ref.constantFlag ? ref.volume : ref.decay) : 0;
	}
	function updateDmc(channel) {
		if (!channel.frequency) return;
		channel.timer -= click + click;
		// TODO: average multiple samples if this loops multiple times
		while (channel.timer < 0) {
			channel.timer += channel.frequency;
			
			if (channel.bytesRemaining) {

				if (channel.shiftPointer == 0) {
					// TODO: add 4 CPU cycles
					var address = channel.address + channel.length - channel.bytesRemaining;
					while (address > 0xFFFF) address -= 0x8000;
					channel.currentByte = cpuMemory[address];
				}
			
				var delta = (channel.currentByte >> channel.shiftPointer) & 1;
				if (delta) {
					if (channel.load < 126) channel.load += 2;
				}
				else {
					if (channel.load > 1) channel.load -= 2;
				}
				
				channel.shiftPointer++;
				if (channel.shiftPointer == 8) {
					channel.shiftPointer = 0;
					channel.bytesRemaining--;
					if (channel.bytesRemaining == 0 && channel.loop) channel.bytesRemaining = channel.length;
				}
			}
			channel.sample = channel.load;
			//channel.sample >>= 2;
		}
	}
	
	var click = 0; // The number of accumulated APU clock cycles (½CPU). Generate sample for output buffer ever 10 clicks	
	var step = 0; // Counts the frame counters steps (currently only LC/Sweep clocks count up)	
	function asyncTick(amount) {
		click = amount;
		
		apuFrames += click;
		if (apuFrames >= lcClock0 && step == 0) {
			apuClockLcSw(false);
			step = 1;
		}
		if (apuFrames >= lcClock1 && step == 1) {
			apuClockLcSw(true);
			step = 2;
		}
		if (apuFrames >= lcClock2 && step == 2) {
			apuClockLcSw(false);
			step = 3;
		}
		if (apuFrames >= lcClock3 && step == 3) {
			apuClockLcSw(true);
			if (enableFrameIrq) pendingFrameCount = true;
			apuFrames -= lcClock2+1;
			step = 0;
		}
		
		updatePulse(npulse1, pulse1);
		updatePulse(npulse2, pulse2);
		updateTriangle(ntriangle, triangle);
		updateNoise(nnoise, noise);
		updateDmc(dmc);
		
		var mixPulse = 95.88 / ((8128 / (npulse1.sample + npulse2.sample)) + 100);
		var mixTnd = 159.79 / (1 / ((ntriangle.sample / 8227) + (nnoise.sample / 12241) + (dmc.sample / 22638)) + 100);
		// NOTE: If you pass in a NaN value (which happens sometimes... for some reason) ios will just cut all audio.
		if (Number.isNaN(mixPulse)) {
			mixPulse = 0;
		}
		if (Number.isNaN(mixTnd)) {
			mixTnd = 0;
		}
		sample = mixPulse + mixTnd;
		//sample = (npulse1.sample + npulse2.sample);
	}
	function tick(amount) {
		running = true;
		if (bufferLength >= bufferSize * 4) return; // Avoid buffer overflow
		
		click += amount;
		if (click > clockStep) {
			
			asyncTick(click);
			
			buffer[bufferPointer] = sample;
			//buffer[bufferPointer] = ntriangle.sample;
			bufferPointer++;
			bufferLength++;
			if (bufferPointer == buffer.length) bufferPointer = 0;

			click -= clockStep;
		}
	}
		
	function initChannel(channel) {
		channel.volume = 0;
		channel.lengthCounter = 0;
		channel.sweepTimer = 0;
		channel.linearReload = false;
	}
	var lengthCounterValues = [10,254, 20,  2, 40,  4, 80,  6, 160,  8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
	var noisePeriodValues = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
	var dmcTimerValues = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106,  84,  72,  54];

	var apuFrames = 0;
	var lcClock0 = 3728;
	var lcClock1 = 7456;
	var lcClock2 = 11185;
	var lcClock3 = 14914;
	var enableFrameIrq = false;
	var frameCounterMode = false;

	function apuClockLcSw(updateSweeps) {
		
		apuFrameLinearCounter();
		
		if (!updateSweeps) return;
		apuFrameSweepChannel(pulse1);
		apuFrameSweepChannel(pulse2);
		apuFrameSweepChannel(triangle);
		apuFrameSweepChannel(noise);
	}
	function apuFrameSweepChannel(channel) {
		if (channel.sweepEnabled) {
			if (channel.sweepTimer <= 0) {
				channel.sweepTimer += channel.sweepPeriod + 1;
				var amount = ((channel.frequency >> channel.sweepShift));
				if (channel.sweepNegate) amount = -amount-1;
				var target = (channel.frequency + amount) & 0xfff;
				if (target < 0x800 && channel.frequency > 7) channel.frequency = target;
			}
			
			channel.sweepTimer -= 1;
			
		}
		if (!channel.haltLengthCounter) channel.lengthCounter = Math.max(0, channel.lengthCounter - 1);
	}
	function apuFrameLinearCounter() {
		if (triangle.linearReload) {
			triangle.linearCounter = triangle.linearReloadValue;
		}
		else {
			triangle.linearCounter = Math.max(0, triangle.linearCounter - 1);
		}
		if (!triangle.haltLengthCounter) triangle.linearReload = false;
		
		clockDivider(pulse1);
		clockDivider(pulse2);
		clockDivider(noise);
	}
	function clockDivider(channel) {
		if (channel.startFlag) {
			channel.startFlag = false;
			channel.decay = 15;
			channel.divider = channel.volume;
		}
		else {
			if (channel.divider) {
				channel.divider--;
				return;
			}
			if (channel.decay) {
				channel.divider = channel.volume;
				channel.decay--;
				return;
			}
			if (channel.haltLengthCounter) channel.decay = 15; // HLC flag is the same as the Decay loop flag
		}
	}
	function dutyCycle(channel, value) {
		channel.haltLengthCounter = ((value & 0x20) != 0);
		channel.constantFlag = ((value & 0x10) != 0);
		channel.dutyCycle = ((value & 0xC0) >> 6);
		channel.volume = (value & 0x0F);
			
		//if (!channel.started) channel.oscillator.start();
		channel.started = true;
	}
	function triangleHalt(channel, value) {
		channel.haltLengthCounter = ((value & 0x80) != 0);
		channel.linearReloadValue = value & 0x7f;
	}
	function noisePeriod(value) {
		var period = value & 0x0F;
		noise.mode = (value & 0x80) ? 6 : 1;
		
		noise.frequency = noisePeriodValues[period];
		//noise.oscillator.playbackRate.setValueAtTime(1 / (1 << ((period)/6)), audio.currentTime);
	}
	function noiseLength(value) {
		noise.lengthCounter = lengthCounterValues[(value & 0xf8) >> 3];
		noise.startFlag = true;
	}
	function timer(channel, value) {
		channel.frequency &= 0xf00;
		channel.frequency |= value;
	}
	function length(channel, value) {
		channel.frequency &= 0x0ff;
		channel.frequency |= (value & 0x07) << 8;
		
		channel.lengthCounter = lengthCounterValues[(value & 0xf8) >> 3];
		channel.linearReload = true;
		channel.startFlag = true;
	}
	function sweep(channel, value) {
		channel.sweepEnabled = ((value & 0x80) != 0);
		channel.sweepPeriod = (value & 0x70) >> 4;
		channel.sweepTimer = channel.sweepPeriod + 1;
		channel.sweepNegate = ((value & 0x08) != 0);
		channel.sweepShift = (value & 0x07);
	}
	function frameCounter(value) {
		//enableFrameIrq = (value & 0x40) == 0;
		frameCounterMode = (value & 0x80) != 0;
		lcClock3 = frameCounterMode ? 18640 : 14914;
		if (frameCounterMode) resetStep();
	}
	function statusRead() {
		//enableFrameIrq = true;
		return
			(pulse1.lengthCounter == 0 ? 0 : 0x01)
			| (pulse2.lengthCounter == 0 ? 0 : 0x02)
			| (triangle.lengthCounter == 0 ? 0 : 0x04)
			| (noise.lengthCounter == 0 ? 0 : 0x08)
			| (dmc.bytesRemaining ? 0x10 : 0);
	}
	function statusWrite(value) {
		if ((value & 0x01) == 0) pulse1.lengthCounter = 0;
		if ((value & 0x02) == 0) pulse2.lengthCounter = 0;
		if ((value & 0x04) == 0) triangle.lengthCounter = 0;
		if ((value & 0x08) == 0) noise.lengthCounter = 0;

		if (value & 0x10) {
			if (dmc.bytesRemaining == 0) {
				dmc.bytesRemaining = dmc.length;
				dmc.shiftPointer = 0;
			}
		}
		else {
			dmc.bytesRemaining = 0;
		}
	}

	function dmcControl(value) {
		dmc.irq = (value & 0x80) != 0;
		dmc.loop = (value & 0x40) != 0;
		dmc.frequency = dmcTimerValues[value & 0xf];
	}
	function dmcLoad(value) {
		dmc.load = value & 0x7f;
	}
	function dmcAddress(value) {
		dmc.address = 0xC000 | (value << 6);
	}
	function dmcLength(value) {
		dmc.length = (value << 4) | 1;
	}
	function setApuRegisters() {
		if (enableAudioEmulation) {
			hwRegisters[0x4000] = new HwRegister(null, function(val) { dutyCycle(pulse1, val); });
			hwRegisters[0x4004] = new HwRegister(null, function(val) { dutyCycle(pulse2, val); });
			hwRegisters[0x400c] = new HwRegister(null, function(val) { dutyCycle(noise, val); });

			hwRegisters[0x4001] = new HwRegister(null, function(val) { sweep(pulse1, val); });
			hwRegisters[0x4005] = new HwRegister(null, function(val) { sweep(pulse2, val); });


			hwRegisters[0x4002] = new HwRegister(null, function(val) { timer(pulse1, val); });
			hwRegisters[0x4006] = new HwRegister(null, function(val) { timer(pulse2, val); });
			hwRegisters[0x400A] = new HwRegister(null, function(val) { timer(triangle, val); });
			hwRegisters[0x400E] = new HwRegister(null, noisePeriod);


			hwRegisters[0x4003] = new HwRegister(null, function(val) { length(pulse1, val); });
			hwRegisters[0x4007] = new HwRegister(null, function(val) { length(pulse2, val); });
			hwRegisters[0x400B] = new HwRegister(null, function(val) { length(triangle, val); });
			hwRegisters[0x400F] = new HwRegister(null, noiseLength);

			hwRegisters[0x4008] = new HwRegister(null, function(val) { triangleHalt(triangle, val); });

			hwRegisters[0x4010] = new HwRegister(null, dmcControl);
			hwRegisters[0x4011] = new HwRegister(null, dmcLoad);
			hwRegisters[0x4012] = new HwRegister(null, dmcAddress);
			hwRegisters[0x4013] = new HwRegister(null, dmcLength);
		}
		hwRegisters[0x4015] = new HwRegister(statusRead, statusWrite);
		hwRegisters[0x4017].write = frameCounter;
	}

	function resetStep() { step = 0; apuFrames = 0; }
		
	var apuInterface = {
		tick: 			tick, // function() { running = true; },
		init: 			initAudio,
		setRegisters: 	setApuRegisters
	};
	return apuInterface;
});
var apu = NewApu();
var controllers = new Uint8Array(2);

var p1Latch = -1;
var p2Latch = -1;
function readP1() {
	p1Latch++;
	return (controllers[0] >> p1Latch) & 1;
}
function readP2() {
	return 0;
}

var mouseBuffer = new ArrayBuffer(4);
var mouseData = new Uint32Array(mouseBuffer);
var mouseBytes = new Uint8Array(mouseBuffer);
mouseBytes[2] = 0x21; // signature
var mouseX = 0;
var mouseY = 0;
function updateMousePosition(e) {
	mouseX += e.movementX;
	mouseY += e.movementY;
	
	mouseBytes[0] = Math.abs(mouseX/2) & 0x7F | ((mouseX < 0) << 7);
	mouseBytes[1] = Math.abs(mouseY/2) & 0x7F | ((mouseY < 0) << 7);	
}
function mouseButton(button, state) {
	var buttonMask = 0;
	if (button == 0) buttonMask = 0x40;
	if (button == 2) buttonMask = 0x80;
	mouseBytes[2] &= (buttonMask ^ 0xFF);
	if (state) mouseBytes[2] |= buttonMask;
}
function readMousePosition() {
	p1Latch++;
	var data = (mouseData[0] >> 31 - p1Latch) & 1;
	if (p1Latch == 31) mouseX = mouseY = 0;
	return data;
}
function controllerLatch() {
	
	mouseBytes[0] = Math.abs(mouseX/2) & 0x7F | ((mouseX < 0) << 7);
	mouseBytes[1] = Math.abs(mouseY/2) & 0x7F | ((mouseY < 0) << 7);	
	
	p1Latch = -1;
	p2Latch = -1;
}

hwRegisters[0x4016] = new HwRegister(readP1, controllerLatch);
hwRegisters[0x4017] = new HwRegister(readP2);


const keyUP = 38;
const keyRIGHT = 39;
const keyDOWN = 40;
const keyLEFT = 37;
const keyX = 88;
const keyZ = 90;
const keyQ = 81;
const keyW = 87;
const keyENTER = 13;
const keySPACE = 32;
const keyCTRL = 17
const keyALT = 18

const ABUTTON = 0x01;
const BBUTTON = 0x02;
const SELECT = 0x04;
const START = 0x08;
const UP = 0x10;
const DOWN = 0x20;
const LEFT = 0x40;
const RIGHT = 0x80;

var buttonNames = {};
buttonNames[UP] = 'UP';
buttonNames[DOWN] = 'DOWN';
buttonNames[LEFT] = 'LEFT';
buttonNames[RIGHT] = 'RIGHT';
buttonNames[BBUTTON] = 'B';
buttonNames[ABUTTON] = 'A';
buttonNames[SELECT] = 'SELECT';
buttonNames[START] = 'START';



var p1Buttons = {};
p1Buttons[keyX] = ABUTTON;
p1Buttons[keyALT] = ABUTTON;
p1Buttons[keyZ] = BBUTTON;
p1Buttons[keyCTRL] = BBUTTON;
p1Buttons[keyQ] = SELECT;
p1Buttons[keyW] = START;
p1Buttons[keyENTER] = START;
p1Buttons[keySPACE] = START;
p1Buttons[keyUP] = UP;
p1Buttons[keyDOWN] = DOWN;
p1Buttons[keyLEFT] = LEFT;
p1Buttons[keyRIGHT] = RIGHT;

function configureKeys() {

	if (localStorage.p1Buttons) p1Buttons = window.JSON.parse(localStorage.p1Buttons);
	
	window.document.body.onblur = function() {
		controllers[0] = 0;
		controllers[1] = 0;
		Mute();
		//Pause();
	};
	window.document.body.onfocus = function() {
		Unmute();
		//Resume();
	}
	window.document.body.onkeydown = function (e) {
		if (configButton) {
			if (e.keyCode == 27) { // ESC
				configButton = 0;
				window.document.body.removeChild(overlay);
				return;
			}
			configP1Buttons[e.keyCode] = configButton;
			configNextButton();
			return;
		}
		if (p1Buttons[e.keyCode]) {
			controllers[0] |= p1Buttons[e.keyCode];
			return false;
		}
	};
	window.document.body.onkeyup = function (e) {
		if (p1Buttons[e.keyCode]) {
			if (controllers[0] & p1Buttons[e.keyCode]) controllers[0] ^= p1Buttons[e.keyCode];
			return false;
		}
	};
	if (enableMouse) UseMouse();
}
var configP1Buttons = null;
var overlay;
var configStatus = 0;
var configButton;
function ButtonConfig() {
	enableMouse = false;
	hwRegisters[0x4016].read = readP1;
	configureKeys();
	
	configP1Buttons = {};
	if (!overlay) overlay = window.document.createElement('div');
	overlay.className = 'overlay';
	window.document.body.appendChild(overlay);
	configStatus = -1;
	configNextButton();
}
function configNextButton() {
	configStatus++;
	configButton = 0;
	var i = 0;
	for (button in buttonNames) {
		if (!buttonNames.hasOwnProperty(button)) continue;
		if (i == configStatus) {
			configButton = button;
			overlay.innerHTML = 'Push key to assign to button: <strong>' + buttonNames[button] + '</strong>';
		}
		i++;
	}
	if (!configButton) {
		p1Buttons = configP1Buttons;
		localStorage.p1Buttons = window.JSON.stringify(p1Buttons);
		window.document.body.removeChild(overlay);
	}
}

var enableMouse = false;
function UseMouse() {
	enableMouse = true;
	if (output) {
		output.canvas.requestPointerLock();
		output.canvas.onclick = function() { if (enableMouse) output.canvas.requestPointerLock(); };
	}
	hwRegisters[0x4016].read = readMousePosition;
}
window.document.addEventListener("mousemove", updateMousePosition, false);
window.document.addEventListener("mousedown", function (e) { mouseButton(e.button, 1) }, false);
window.document.addEventListener("mouseup", function (e) { mouseButton(e.button, 0) }, false);

var Controller = {};

function buttonPressed(button) {
	controllers[0] |= button;
}

function buttonReleased(button) {
	if (controllers[0] & button) {
		controllers[0] ^= button;
	}

	// Works around an embed issue where the game loses focus when you use the controller...
	$('body').focus();
}

Controller.aPressed = function() { return buttonPressed(ABUTTON); };
Controller.aReleased = function() { return buttonReleased(ABUTTON); };
Controller.bPressed = function() { return buttonPressed(BBUTTON); };
Controller.bReleased = function() { return buttonReleased(BBUTTON); };

Controller.selectPressed = function() { return buttonPressed(SELECT); };
Controller.selectReleased = function() { return buttonReleased(SELECT); };
Controller.startPressed = function() { return buttonPressed(START); };
Controller.startReleased = function() { return buttonReleased(START); };

Controller.upPressed = function() { return buttonPressed(UP); };
Controller.upReleased = function() { return buttonReleased(UP); };
Controller.downPressed = function() { return buttonPressed(DOWN); };
Controller.downReleased = function() { return buttonReleased(DOWN); };
Controller.leftPressed = function() { return buttonPressed(LEFT); };
Controller.leftReleased = function() { return buttonReleased(LEFT); };
Controller.rightPressed = function() { return buttonPressed(RIGHT); };
Controller.rightReleased = function() { return buttonReleased(RIGHT); };
const illegalOpcodes = true;

function addrRead(address) {
	return mapRead[address & 0xC000 ? 1 : 0](address);
}
function addrWrite(address, value) {
	return mapWrite[address & 0xC000 ? 1 : 0](address, value);
}


	var referenceBuffer = new ArrayBuffer(2);
	var referenceBytes = new Uint8Array(referenceBuffer);
	var reference = new Uint16Array(referenceBuffer);
	var signed = new Int8Array(referenceBuffer);
	
	var opcodes = [];

	const NOP = 0xEA;
	
	opcodes[NOP] = function() { };
	
	const CMPi = 0xC9;
	const CMPzp = 0xC5;
	const CMPzpX = 0xD5;
	const CMPa = 0xCD;
	const CMPaX = 0xDD;
	const CMPaY = 0xD9;
	const CMPiX = 0xC1;
	const CMPiY = 0xD1;
	
	const CPXi = 0xE0;
	const CPXzp = 0xE4;
	const CPXa = 0xEC;
	const CPYi = 0xC0;
	const CPYzp = 0xC4;
	const CPYa = 0xCC;
	
	opcodes[CMPi] = function() { cmp(A, param8()); };
	opcodes[CMPzp] = function() { cmp(A, readValue(param8(), -1, true)); };
	opcodes[CMPzpX] = function() { cmp(A, readValue(param8(), X, true)); };
	opcodes[CMPa] = function() { cmp(A, readValue(param16(), -1)); };
	opcodes[CMPaX] = function() { cmp(A, readValue(param16(), X)); };
	opcodes[CMPaY] = function() { cmp(A, readValue(param16(), Y)); };
	opcodes[CMPiX] = function() { cmp(A, readValue(indirectX(), -1)); };
	opcodes[CMPiY] = function() { cmp(A, readValue(indirectY(), -1)); };

	opcodes[CPXi] = function() { cmp(X, param8()); };
	opcodes[CPXzp] = function() { cmp(X, readValue(param8(), -1, true)); };
	opcodes[CPXa] = function() { cmp(X, readValue(param16(), -1)); };
	opcodes[CPYi] = function() { cmp(Y, param8()); };
	opcodes[CPYzp] = function() { cmp(Y, readValue(param8(), -1, true)); };
	opcodes[CPYa] = function() { cmp(Y, readValue(param16(), -1)); };
	
	function cmp(registerOffset, value) {
		adc(registerOffset, 255 - value, true, true);
	}
	
window.testOp = function() {
	cpuRegisters[1] = 100;
	cmp(1, 229);
	console.log('<','N='+n,'Z='+z,'C='+c);
	cmp(1, 101);
	console.log('<','N='+n,'Z='+z,'C='+c);
	cmp(1, 100);
	console.log('equal','N='+n,'Z='+z,'C='+c);
	cpuRegisters[1] = 200;
	cmp(1, 3);
	console.log('>','N='+n,'Z='+z,'C='+c);
	cmp(1, 6);
	console.log('>','N='+n,'Z='+z,'C='+c);
}
	
	const ADCi = 0x69;
	const ADCzp = 0x65;
	const ADCzpX = 0x75
	const ADCa = 0x6D;
	const ADCaX = 0x7D;
	const ADCaY = 0x79;
	const ADCiX = 0x61;
	const ADCiY = 0x71;

	const SBCi = 0xE9;
	const SBCzp = 0xE5;
	const SBCzpX = 0xF5
	const SBCa = 0xED;
	const SBCaX = 0xFD;
	const SBCaY = 0xF9;
	const SBCiX = 0xE1;
	const SBCiY = 0xF1;

	opcodes[ADCi] = function() { cpuRegisters[A] = adc(A, param8(), c); }
	opcodes[ADCzp] = function() { cpuRegisters[A] = adc(A, readValue(param8(), -1, true), c); }
	opcodes[ADCzpX] = function() { cpuRegisters[A] = adc(A, readValue(param8(), X, true), c); }
	opcodes[ADCa] = function() { cpuRegisters[A] = adc(A, readValue(param16(), -1), c); }
	opcodes[ADCaX] = function() { cpuRegisters[A] = adc(A, readValue(param16(), X), c); }
	opcodes[ADCaY] = function() { cpuRegisters[A] = adc(A, readValue(param16(), Y), c); }
	opcodes[ADCiX] = function() { cpuRegisters[A] = adc(A, readValue(indirectX(), -1), c); }
	opcodes[ADCiY] = function() { cpuRegisters[A] = adc(A, readValue(indirectY(), -1), c); }

	opcodes[SBCi] = function() { cpuRegisters[A] = adc(A, 255 - param8(), c); }
	opcodes[SBCzp] = function() { cpuRegisters[A] = adc(A, 255 - readValue(param8(), -1, true), c); }
	opcodes[SBCzpX] = function() { cpuRegisters[A] = adc(A, 255 - readValue(param8(), X, true), c); }
	opcodes[SBCa] = function() { cpuRegisters[A] = adc(A, 255 - readValue(param16(), -1), c); }
	opcodes[SBCaX] = function() { cpuRegisters[A] = adc(A, 255 - readValue(param16(), X), c); }
	opcodes[SBCaY] = function() { cpuRegisters[A] = adc(A, 255 - readValue(param16(), Y), c); }
	opcodes[SBCiX] = function() { cpuRegisters[A] = adc(A, 255 - readValue(indirectX(), -1), c); }
	opcodes[SBCiY] = function() { cpuRegisters[A] = adc(A, 255 - readValue(indirectY(), -1), c); }
	
	function adc(registerOffset, value, carry, dontCheckOverflow) {
		signed[0] = cpuRegisters[registerOffset];
		signed[1] = value;
		
		var result = signed[0] + signed[1] + (carry ? 1 : 0);
		if (!dontCheckOverflow) v = (result < -128 || result > 127);
		
		var result = referenceBytes[0] + referenceBytes[1] + (carry ? 1 : 0);
		c = ((result & 0x100) != 0);
		
		result = result & 0xFF;
		z = (result == 0);
		n = (result >= 128);
			
		return result;
	}
	
	/*window.testAdc = function(val1, val2, carry) {
		
		cpuRegisters[A] = val1;
		var result = adc(A, val2, carry, true);
		
		console.log('Result : $' + result.toString(16));	
		console.log('N: ' + n, 'Z: ' + z, 'C: ' + c, 'V: ' + v);	
	}*/
	
	const CLC = 0x18;
	const SEC = 0x38;
	const CLI = 0x58;
	const SEI = 0x78;
	const CLV = 0xB8;
	const CLD = 0xD8;
	const SED = 0xF8;

	opcodes[CLC] = function() { c = false; };
	opcodes[SEC] = function() { c = true; };
	opcodes[CLI] = function() { interruptFlag = false; };
	opcodes[SEI] = function() { interruptFlag = true; };
	opcodes[CLV] = function() { v = false; };
	opcodes[CLD] = function() {  };
	opcodes[SED] = function() {  };

	const TAX = 0xAA;
	const TXA = 0x8A;
	const DEX = 0xCA;
	const INX = 0xE8;
	const TAY = 0xA8;
	const TYA = 0x98;
	const DEY = 0x88;
	const INY = 0xC8;

	opcodes[TAX] = function() { loadValue(cpuRegisters[A], X); };
	opcodes[TXA] = function() { loadValue(cpuRegisters[X], A); };
	opcodes[DEX] = function() { loadValue(cpuRegisters[X]-1, X); };
	opcodes[INX] = function() { loadValue(cpuRegisters[X]+1, X); };
	opcodes[TAY] = function() { loadValue(cpuRegisters[A], Y); };
	opcodes[TYA] = function() { loadValue(cpuRegisters[Y], A); };
	opcodes[DEY] = function() { loadValue(cpuRegisters[Y]-1, Y); };
	opcodes[INY] = function() { loadValue(cpuRegisters[Y]+1, Y); };
	
	const LDAi = 0xA9;
	const LDAzp = 0xA5;
	const LDAzpX = 0xB5;
	const LDAa = 0xAD;
	const LDAaX = 0xBD;
	const LDAaY = 0XB9;
	const LDAiX = 0xA1;
	const LDAiY = 0xB1;
	
	const LDXi = 0xA2;
	const LDXzp = 0xA6;
	const LDXzpY = 0xB6;
	const LDXa = 0xAE;
	const LDXaY = 0xBE;

	const LDYi = 0xA0;
	const LDYzp = 0xA4;
	const LDYzpX = 0xB4;
	const LDYa = 0xAC;
	const LDYaX = 0xBC;
	
	const STAzp = 0x85;
	const STAzpX = 0x95;
	const STAa = 0x8D;
	const STAaX = 0x9D;
	const STAaY = 0x99;
	const STAiX = 0x81;
	const STAiY = 0x91;
	
	const STXzp = 0x86;
	const STXzpY = 0x96;
	const STXa = 0x8E;

	const STYzp = 0x84;
	const STYzpX = 0x94;
	const STYa = 0x8C;
	
	const TXS = 0x9A;
	const TSX = 0xBA;
	const PHA = 0x48;
	const PLA = 0x68;
	const PHP = 0x08;
	const PLP = 0x28;
	
	const ANDi = 0x29;
	const ANDzp = 0x25;
	const ANDzpX = 0x35;
	const ANDa = 0x2D;
	const ANDaX = 0x3D;
	const ANDaY = 0x39;
	const ANDiX = 0x21;
	const ANDiY = 0x31;
	
	const BPL = 0x10;
	const BMI = 0x30;
	const BVC = 0x50;
	const BVS = 0x70;
	const BCC = 0x90;
	const BCS = 0xB0;
	const BNE = 0xD0;
	const BEQ = 0xF0;
	
	opcodes[BPL] = function() { branch(param8(), !n); };
	opcodes[BMI] = function() { branch(param8(), n); };
	opcodes[BVC] = function() { branch(param8(), !v); };
	opcodes[BVS] = function() { branch(param8(), v); };
	opcodes[BCC] = function() { branch(param8(), !c); };
	opcodes[BCS] = function() { branch(param8(), c); };
	opcodes[BNE] = function() { branch(param8(), !z); };
	opcodes[BEQ] = function() { branch(param8(), z); };
	
	const DECzp = 0xC6;
	const DECzpX = 0xD6;
	const DECa = 0xCE;
	const DECaX = 0xDE;

	opcodes[DECzp] = function() { inc(-1, param8(), -1, true); };
	opcodes[DECzpX] = function() { inc(-1, param8(), X, true); };
	opcodes[DECa] = function() { inc(-1, param16()); };
	opcodes[DECaX] = function() { inc(-1, param16(), X); };
	
	const INCzp = 0xE6;
	const INCzpX = 0xF6;
	const INCa = 0xEE;
	const INCaX = 0xFE;

	opcodes[INCzp] = function() { inc(1, param8(), -1, true); };
	opcodes[INCzpX] = function() { inc(1, param8(), X, true); };
	opcodes[INCa] = function() { inc(1, param16()); };
	opcodes[INCaX] = function() { inc(1, param16(), X); };
	
	const JSR = 0x20;
	const RTS = 0x60;
	const JMPa = 0x4C;
	const JMPi = 0x6c;
	
	opcodes[JSR] = function() {
		var byt1 = param8();
		push(pcByte[1]);
		push(pcByte[0]);
		var byt2 = param8();
		pcByte[0] = byt1;
		pcByte[1] = byt2;
	};
	opcodes[RTS] = function() {
		pcByte[0] = pull();
		pcByte[1] = pull();		
		pc[0]++;
	};
	opcodes[JMPa] = function() { pc[0] = param16(); };

	opcodes[JMPi] = function() {
		reference[0] = param16();
		pcByte[0] = readValue(reference[0]);
		referenceBytes[0]++;
		pcByte[1] = readValue(reference[0]);
	};
	
	const LSR = 0x4A;
	const LSRzp = 0x46;
	const LSRzpX = 0x56;
	const LSRa = 0x4E;
	const LSRaX = 0x5E;
	const ASL = 0x0A;
	const ASLzp = 0x06;
	const ASLzpX = 0x16;
	const ASLa = 0x0E;
	const ASLaX = 0x1E;

	const ROL = 0x2A;
	const ROLzp = 0x26;
	const ROLzpX = 0x36;
	const ROLa = 0x2E;
	const ROLaX = 0x3E;
	const ROR = 0x6A;
	const RORzp = 0x66;
	const RORzpX = 0x76;
	const RORa = 0x6E;
	const RORaX = 0x7E;

	opcodes[LSR] = function() { cpuRegisters[A] = lsr(cpuRegisters[A]); };
	opcodes[LSRzp] = function() { lsrA(param8(), -1, false, true); };
	opcodes[LSRzpX] = function() { lsrA(param8(), X, false, true); };
	opcodes[LSRa] = function() { lsrA(param16(), -1); };
	opcodes[LSRaX] = function() { lsrA(param16(), X); };
	opcodes[ASL] = function() { cpuRegisters[A] = asl(cpuRegisters[A]); };
	opcodes[ASLzp] = function() { aslA(param8(), -1, false, true); };
	opcodes[ASLzpX] = function() { aslA(param8(), X, false, true); };
	opcodes[ASLa] = function() { aslA(param16(), -1); };
	opcodes[ASLaX] = function() { aslA(param16(), X); };

	opcodes[ROR] = function() { cpuRegisters[A] = lsr(cpuRegisters[A], c); };
	opcodes[RORzp] = function() { lsrA(param8(), -1, c, true); };
	opcodes[RORzpX] = function() { lsrA(param8(), X, c, true); };
	opcodes[RORa] = function() { lsrA(param16(), -1, c); };
	opcodes[RORaX] = function() { lsrA(param16(), X, c); };
	opcodes[ROL] = function() { cpuRegisters[A] = asl(cpuRegisters[A], c); };
	opcodes[ROLzp] = function() { aslA(param8(), -1, c, true); };
	opcodes[ROLzpX] = function() { aslA(param8(), X, c, true); };
	opcodes[ROLa] = function() { aslA(param16(), -1, c); };
	opcodes[ROLaX] = function() { aslA(param16(), X, c); };
	
	function lsr(value, carry) {
		c = ((value & 0x01) != 0)
		var result = value >> 1 | (carry ? 0x80 : 0);
		z = (result == 0);
		n = (result >= 128);
		return result;
	}
	function asl(value, carry) {
		c = ((value & 0x80) != 0)
		var result = value << 1 & 0xFF | (carry ? 0x01 : 0);
		z = (result == 0);
		n = (result >= 128);
		return result;
	}
	function lsrA(address, offsetByRegister, carry, isZP) {
		if (offsetByRegister >= 0) address = (address + cpuRegisters[offsetByRegister]) & (isZP ? 0xff : 0xffff);
		var val = (hwRegisters[address] && hwRegisters[address].read)
		? hwRegisters[address].read()
		: addrRead(address);
		
		val = lsr(val, carry);
		if (hwRegisters[address]) {
			if (hwRegisters[address].store) {
				hwRegisters[address].store(val, address);
			}
		}
		else {
			addrWrite(address, val);
		}
	}
	function aslA(address, offsetByRegister, carry, isZP) {
		if (offsetByRegister >= 0) address = (address + cpuRegisters[offsetByRegister]) & (isZP ? 0xff : 0xffff);
		var val = (hwRegisters[address] && hwRegisters[address].read)
		? hwRegisters[address].read()
		: addrRead(address);
		
		val = asl(val, carry);
		if (hwRegisters[address]) {
			if (hwRegisters[address].store) {
				hwRegisters[address].store(val, address);
			}
		}
		else {
			addrWrite(address, val);
		}
	}

	const BITzp = 0x24;
	const BITa = 0x2C;
	
	opcodes[BITzp] = function() { bit(readValue(param8())); };
	opcodes[BITa] = function() { bit(readValue(param16())); };

	function bit(value) {
		z = ((value & cpuRegisters[A]) == 0);
		n = ((value & 0x80) != 0);
		v = ((value & 0x40) != 0);
	}

	const EORi = 0x49;
	const EORzp = 0x45;
	const EORzpX = 0x55;
	const EORa = 0x4D;
	const EORaX = 0x5D;
	const EORaY = 0x59;
	const EORiX = 0x41;
	const EORiY = 0x51;

	const ORAi = 0x09;
	const ORAzp = 0x05;
	const ORAzpX = 0x15;
	const ORAa = 0x0D;
	const ORAaX = 0x1D;
	const ORAaY = 0x19;
	const ORAiX = 0x01;
	const ORAiY = 0x11;
	
	opcodes[EORi] = function() { loadValue(param8() ^ cpuRegisters[A], A); };
	opcodes[EORzp] = function() { loadValue(readValue(param8(), -1, true) ^ cpuRegisters[A], A); };
	opcodes[EORzpX] = function() { loadValue(readValue(param8(), X, true) ^ cpuRegisters[A], A); };
	opcodes[EORa] = function() { loadValue(readValue(param16(), -1) ^ cpuRegisters[A], A); };
	opcodes[EORaX] = function() { loadValue(readValue(param16(), X) ^ cpuRegisters[A], A); };
	opcodes[EORaY] = function() { loadValue(readValue(param16(), Y) ^ cpuRegisters[A], A); };
	opcodes[EORiX] = function() { loadValue(readValue(indirectX(), -1) ^ cpuRegisters[A], A); };
	opcodes[EORiY] = function() { loadValue(readValue(indirectY(), -1) ^ cpuRegisters[A], A); };

	opcodes[ORAi] = function() { loadValue(param8() | cpuRegisters[A], A); };
	opcodes[ORAzp] = function() { loadValue(readValue(param8(), -1, true) | cpuRegisters[A], A); };
	opcodes[ORAzpX] = function() { loadValue(readValue(param8(), X, true) | cpuRegisters[A], A); };
	opcodes[ORAa] = function() { loadValue(readValue(param16(), -1) | cpuRegisters[A], A); };
	opcodes[ORAaX] = function() { loadValue(readValue(param16(), X) | cpuRegisters[A], A); };
	opcodes[ORAaY] = function() { loadValue(readValue(param16(), Y) | cpuRegisters[A], A); };
	opcodes[ORAiX] = function() { loadValue(readValue(indirectX(), -1) | cpuRegisters[A], A); };
	opcodes[ORAiY] = function() { loadValue(readValue(indirectY(), -1) | cpuRegisters[A], A); };

	const RTI = 0x40;
	opcodes[RTI] = returnFromIrq;

	const A = 0;
	const X = 1;
	const Y = 2;
	const SP = 3;
	const NMI = 0;
	const RESET = 1;
	const IRQ = 2;

	function branch(offset, doIt) {
		if (!doIt) return;
		currentCycleCount++;
		var prevPage = pcByte[1];
		signed[0] = offset;
		pc[0] += signed[0];
		if (pcByte[1] != prevPage) currentCycleCount++;
	}
	
	function inc(amount, address, offsetByRegister, isZP) {
		if (offsetByRegister >= 0) address = (address + cpuRegisters[offsetByRegister]) & (isZP ? 0xff : 0xffff);
		var val = (hwRegisters[address] && hwRegisters[address].read)
		? hwRegisters[address].read()
		: addrRead(address);

		if (hwRegisters[address]) {
			if (hwRegisters[address].store) {
				hwRegisters[address].store(val, address);
				hwRegisters[address].store(val + amount, address);
			}
			val += amount;
		}
		else {
			addrWrite(address, val);
			val += amount;
			addrWrite(address, val);
		}
		z = ((val & 0xff) === 0);
		n = ((val & 0xff) >= 128);
	}
	
	function readValue(address, offsetByRegister, isZP) {
		if (offsetByRegister >= 0) {
			var addr2 = (address + cpuRegisters[offsetByRegister]) & (isZP ? 0xff : 0xffff);
			if ((address & 0xFF00) != (addr2 & 0xFF00)) currentCycleCount++;
			address = addr2;
		}
		if (hwRegisters[address] && hwRegisters[address].read) {
			return hwRegisters[address].read();
		}
		else {
			return addrRead(address);
		}
	}
	function loadValue(value, registerOffset) {
		cpuRegisters[registerOffset] = value;
		z = (cpuRegisters[registerOffset] === 0)
		n = (cpuRegisters[registerOffset] >= 128)
		
		return value; // useful for LAX
	}
	function storeValue(registerOffset, address, offsetByRegister, isZP) {
		if (offsetByRegister >= 0) {
			var addr2 = (address + cpuRegisters[offsetByRegister]) & (isZP ? 0xff : 0xffff);
			if (registerOffset > 0 && ((address & 0xFF00) != (addr2 & 0xFF00))) currentCycleCount++;
			address = addr2;
		}
		if (hwRegisters[address]) {
			if (hwRegisters[address].store) hwRegisters[address].store(cpuRegisters[registerOffset], address);
		}
		else {
			addrWrite(address, cpuRegisters[registerOffset]);
		}
	}
	function storeValueDirect(value, address, offsetByRegister, isZP) {
		if (offsetByRegister >= 0) {
			var address = (address + cpuRegisters[offsetByRegister]) & (isZP ? 0xff : 0xffff);
		}
		if (hwRegisters[address]) {
			if (hwRegisters[address].store) hwRegisters[address].store(value, address);
		}
		else {
			addrWrite(address, value);
		}
	}
	function indirectY(free) {
		var zp = param8();
		var addr1 = cpuMemory[zp] + (cpuMemory[(zp+1) & 0xff] << 8);
		var addr2 = (addr1 + cpuRegisters[Y]) & 0xffff;
		if (!free & ((addr1 & 0xFF00) != (addr2 & 0xFF00))) currentCycleCount++;
		return addr2;
	}
	function indirectX() {
		var zp = param8() + cpuRegisters[X];
		return cpuMemory[zp & 0xff] + (cpuMemory[(zp+1) & 0xff] << 8);
	}
	function param16() {
		var val = addrRead(pc[0]) + (addrRead(pc[0]+1) << 8);
		pc[0] += 2;
		return val;
	}
	function param8() {
		var val = addrRead(pc[0]);
		pc[0]++;
		return val;
	}
		
	opcodes[TSX] = function() { loadValue(cpuRegisters[SP], X); };
	opcodes[TXS] = function() { cpuRegisters[SP] = cpuRegisters[X]; };
	opcodes[PHA] = function() { push(cpuRegisters[A]) };
	opcodes[PLA] = function() { loadValue(pull(), A); };
	opcodes[PHP] = function() { push(getFlags()) };
	opcodes[PLP] = function() { setFlags(pull()); };
	
	function push(value) {
		stack[cpuRegisters[SP]] = value;
		cpuRegisters[SP]--;
	}
	function pull(value) {
		cpuRegisters[SP]++;
		return stack[cpuRegisters[SP]];
	}
	
	opcodes[LDAi] = function() { loadValue(param8(), A); };
	opcodes[LDAzp] = function() { loadValue(readValue(param8(), -1, true), A); };
	opcodes[LDAzpX] = function() { loadValue(readValue(param8(), X, true), A); };
	opcodes[LDAa] = function() { loadValue(readValue(param16(), -1), A); };
	opcodes[LDAaX] = function() { loadValue(readValue(param16(), X), A); };
	opcodes[LDAaY] = function() { loadValue(readValue(param16(), Y), A); };
	opcodes[LDAiX] = function() { loadValue(readValue(indirectX(), -1), A); };
	opcodes[LDAiY] = function() { loadValue(readValue(indirectY(), -1), A); };

	opcodes[LDYi] = function() { loadValue(param8(), Y); };
	opcodes[LDYzp] = function() { loadValue(readValue(param8(), -1, true), Y); };
	opcodes[LDYzpX] = function() { loadValue(readValue(param8(), X, true), Y); };
	opcodes[LDYa] = function() { loadValue(readValue(param16(), -1), Y); };
	opcodes[LDYaX] = function() { loadValue(readValue(param16(), X), Y); };

	opcodes[LDXi] = function() { loadValue(param8(), X); };
	opcodes[LDXzp] = function() { loadValue(readValue(param8(), -1, true), X); };
	opcodes[LDXzpY] = function() { loadValue(readValue(param8(), Y, true), X); };
	opcodes[LDXa] = function() { loadValue(readValue(param16(), -1), X); };
	opcodes[LDXaY] = function() { loadValue(readValue(param16(), Y), X); };
	
	opcodes[STAzp] = function() { storeValue(A, param8(), -1, true); };
	opcodes[STAzpX] = function() { storeValue(A, param8(), X, true); };
	opcodes[STAa] = function() { storeValue(A, param16(), -1); };
	opcodes[STAaX] = function() { storeValue(A, param16(), X); };
	opcodes[STAaY] = function() { storeValue(A, param16(), Y); };
	opcodes[STAiX] = function() { storeValue(A, indirectX()); };
	opcodes[STAiY] = function() { storeValue(A, indirectY(true)); };

	opcodes[STXzp] = function() { storeValue(X, param8(), -1, true); };
	opcodes[STXzpY] = function() { storeValue(X, param8(), Y, true); };
	opcodes[STXa] = function() { storeValue(X, param16(), -1); };
	opcodes[STYzp] = function() { storeValue(Y, param8(), -1, true); };
	opcodes[STYzpX] = function() { storeValue(Y, param8(), X, true); };
	opcodes[STYa] = function() { storeValue(Y, param16(), -1); };

	
	opcodes[ANDi] = function() { loadValue(param8() & cpuRegisters[A], A); };
	opcodes[ANDzp] = function() { loadValue(readValue(param8(), -1, true) & cpuRegisters[A], A); };
	opcodes[ANDzpX] = function() { loadValue(readValue(param8(), X, true) & cpuRegisters[A], A); };
	opcodes[ANDa] = function() { loadValue(readValue(param16(), -1) & cpuRegisters[A], A); };
	opcodes[ANDaX] = function() { loadValue(readValue(param16(), X) & cpuRegisters[A], A); };
	opcodes[ANDaY] = function() { loadValue(readValue(param16(), Y) & cpuRegisters[A], A); };
	opcodes[ANDiX] = function() { loadValue(readValue(indirectX(), -1) & cpuRegisters[A], A); };
	opcodes[ANDiY] = function() { loadValue(readValue(indirectY(), -1) & cpuRegisters[A], A); };
	
	
	const BRK = 0x00;
	const LAXa = 0xAF;
	const LAXaY = 0xBF;
	const LAXzp = 0xA7;
	const LAXzpY = 0xB7;
	const LAXiX = 0xA3;
	const LAXiY = 0xB3;
	const SAX = 0xCB;
	const ALR = 0x4B;
	const ARR = 0x6B;
	const AXSa = 0x8F;
	const AXSzp = 0x87;
	const AXSzpY = 0x97;
	const AXSiX = 0x83;
	const ANC2 = 0x2B;
	const ANC1 = 0x0B;
	
	const INSa = 0xEF;
	const INSaX = 0xFF;
	const INSaY = 0xFB;
	const INSzp = 0xE7;
	const INSzpX = 0xF7;
	const INSiX = 0xE3;
	const INSiY = 0xF3;

	var nop1 = [0x1A,0x3A,0x5A,0x7A,0xDA,0xFA];
	var nop2 = [0x80,0x82,0xC2,0xE2,0x04,0x14,0x34,0x44,0x54,0x64,0x74,0xD4,0xF4];
	var nop3 = [0x0C,0x1C,0x3C,0x5C,0x7C,0xDC,0xFC];
	
	
	if (illegalOpcodes) {
		
		opcodes[BRK] = function() { pc[0]++; pendingIrq = true; }; // not really illegal, but catching it helps with debugging :)

		opcodes[LAXzp] = function() { cpuRegisters[X] = loadValue(readValue(param8(), -1, true), A); };
		opcodes[LAXzpY] = function() { cpuRegisters[X] = loadValue(readValue(param8(), Y, true), A); };
		opcodes[LAXa] = function() { cpuRegisters[X] = loadValue(readValue(param16(), -1), A); };
		opcodes[LAXaY] = function() { cpuRegisters[X] = loadValue(readValue(param16(), Y), A); };
		opcodes[LAXiX] = function() { cpuRegisters[X] = loadValue(readValue(indirectX(), -1), A); };
		opcodes[LAXiY] = function() { cpuRegisters[X] = loadValue(readValue(indirectY(), -1), A); };
		
		opcodes[SAX] = function() {
			cpuRegisters[X] &= cpuRegisters[A];
			cpuRegisters[X] = adc(X, 255 - param8(), true, true);
		};
		opcodes[AXSa] = function() { storeValueDirect(cpuRegisters[X] & cpuRegisters[A], param16()); };
		opcodes[AXSzp] = function() { storeValueDirect(cpuRegisters[X] & cpuRegisters[A], param8(), -1, true); };
		opcodes[AXSzpY] = function() { storeValueDirect(cpuRegisters[X] & cpuRegisters[A], param8(), Y, true); };
		opcodes[AXSiX] = function() { storeValueDirect(cpuRegisters[X] & cpuRegisters[A], indirectX(), -1); };
		
		opcodes[ALR] = function() { cpuRegisters[A] = lsr(cpuRegisters[A] & param8()); };
		opcodes[ARR] = function() { cpuRegisters[A] = lsr(cpuRegisters[A] & param8(), C); };
		
		opcodes[ANC1] = opcodes[ANC2] = function() { loadValue(param8() & cpuRegisters[A], A); c = n; };

		opcodes[INSa] = function() { var addr = param16(); inc(1, addr, -1); cpuRegisters[A] = adc(A, 255 - readValue(addr, -1), c); }
		// 0xFF: opcodes[INSaX] = function() { var addr = param16(); inc(1, addr, X); cpuRegisters[A] = adc(A, 255 - readValue(addr, X), c); }
		opcodes[INSaY] = function() { var addr = param16(); inc(1, addr, Y); cpuRegisters[A] = adc(A, 255 - readValue(addr, Y), c); }
		opcodes[INSzp] = function() { var addr = param8(); inc(1, addr, -1, true); cpuRegisters[A] = adc(A, 255 - readValue(addr, -1, true), c); }
		opcodes[INSzpX] = function() { var addr = param8(); inc(1, addr, X, true); cpuRegisters[A] = adc(A, 255 - readValue(addr, X, true), c); }
		opcodes[INSiX] = function() { var addr = indirectX(); inc(1, addr, -1); cpuRegisters[A] = adc(A, 255 - readValue(addr, -1), c); }
		opcodes[INSiY] = function() { var addr = indirectY(); inc(1, addr, -1); cpuRegisters[A] = adc(A, 255 - readValue(addr, -1), c); }

		
		for (var i = 0; i < nop1.length; i++) opcodes[nop1[i]] = function() { };
		for (var i = 0; i < nop1.length; i++) opcodes[nop2[i]] = function() { pc[0]++; };
		for (var i = 0; i < nop3.length; i++) opcodes[nop3[i]] = function() { pc[0] += 2; };

	}
	
	
	opcodeCycles = [];
opcodeCycles[BPL] = 2;
opcodeCycles[BMI] = 2;
opcodeCycles[BVC] = 2;
opcodeCycles[BVS] = 2;
opcodeCycles[BCC] = 2;
opcodeCycles[BCS] = 2;
opcodeCycles[BNE] = 2;
opcodeCycles[BEQ] = 2;
opcodeCycles[CLC] = 2;
opcodeCycles[SEC] = 2;
opcodeCycles[CLI] = 2;
opcodeCycles[SEI] = 2;
opcodeCycles[CLV] = 2;
opcodeCycles[CLD] = 2;
opcodeCycles[SED] = 2;
opcodeCycles[TAX] = 2;
opcodeCycles[TXA] = 2;
opcodeCycles[DEX] = 2;
opcodeCycles[INX] = 2;
opcodeCycles[TAY] = 2;
opcodeCycles[TYA] = 2;
opcodeCycles[DEY] = 2;
opcodeCycles[INY] = 2;
opcodeCycles[ADCi] = 2;
opcodeCycles[ADCzp] = 3;
opcodeCycles[ADCzpX] = 4;
opcodeCycles[ADCa] = 4;
opcodeCycles[ADCaX] = 4;
opcodeCycles[ADCaY] = 4;
opcodeCycles[ADCiX] = 6;
opcodeCycles[ADCiY] = 5;
opcodeCycles[ANDi] = 2;
opcodeCycles[ANDzp] = 3;
opcodeCycles[ANDzpX] = 4;
opcodeCycles[ANDa] = 4;
opcodeCycles[ANDaX] = 4;
opcodeCycles[ANDaY] = 4;
opcodeCycles[ANDiX] = 6;
opcodeCycles[ANDiY] = 5;
opcodeCycles[ASL] = 2;
opcodeCycles[ASLzp] = 5;
opcodeCycles[ASLzpX] = 6;
opcodeCycles[ASLa] = 6;
opcodeCycles[ASLaX] = 7;
opcodeCycles[BITzp] = 3;
opcodeCycles[BITa] = 4;
opcodeCycles[BRK] = 7;
opcodeCycles[CMPi] = 2;
opcodeCycles[CMPzp] = 3;
opcodeCycles[CMPzpX] = 4;
opcodeCycles[CMPa] = 4;
opcodeCycles[CMPaX] = 4;
opcodeCycles[CMPaY] = 4;
opcodeCycles[CMPiX] = 6;
opcodeCycles[CMPiY] = 5;
opcodeCycles[CPXi] = 2;
opcodeCycles[CPXzp] = 3;
opcodeCycles[CPXa] = 4;
opcodeCycles[CPYi] = 2;
opcodeCycles[CPYzp] = 3;
opcodeCycles[CPYa] = 4;
opcodeCycles[DECzp] = 5;
opcodeCycles[DECzpX] = 6;
opcodeCycles[DECa] = 6;
opcodeCycles[DECaX] = 7;
opcodeCycles[EORi] = 2;
opcodeCycles[EORzp] = 3;
opcodeCycles[EORzpX] = 4;
opcodeCycles[EORa] = 4;
opcodeCycles[EORaX] = 4;
opcodeCycles[EORaY] = 4;
opcodeCycles[EORiX] = 6;
opcodeCycles[EORiY] = 5;
opcodeCycles[INCzp] = 5;
opcodeCycles[INCzpX] = 6;
opcodeCycles[INCa] = 6;
opcodeCycles[INCaX] = 7;
opcodeCycles[JMPa] = 3;
opcodeCycles[JMPi] = 5;
opcodeCycles[JSR] = 6;
opcodeCycles[LDAi] = 2;
opcodeCycles[LDAzp] = 3;
opcodeCycles[LDAzpX] = 4;
opcodeCycles[LDAa] = 4;
opcodeCycles[LDAaX] = 4;
opcodeCycles[LDAaY] = 4;
opcodeCycles[LDAiX] = 6;
opcodeCycles[LDAiY] = 5;
opcodeCycles[LDXi] = 2;
opcodeCycles[LDXzp] = 3;
opcodeCycles[LDXzpY] = 4;
opcodeCycles[LDXa] = 4;
opcodeCycles[LDXaY] = 4;
opcodeCycles[LDYi] = 2;
opcodeCycles[LDYzp] = 3;
opcodeCycles[LDYzpX] = 4;
opcodeCycles[LDYa] = 4;
opcodeCycles[LDYaX] = 4;
opcodeCycles[LSR] = 2;
opcodeCycles[LSRzp] = 5;
opcodeCycles[LSRzpX] = 6;
opcodeCycles[LSRa] = 6;
opcodeCycles[LSRaX] = 7;
opcodeCycles[NOP] = 2;
opcodeCycles[ORAi] = 2;
opcodeCycles[ORAzp] = 3;
opcodeCycles[ORAzpX] = 4;
opcodeCycles[ORAa] = 4;
opcodeCycles[ORAaX] = 4;
opcodeCycles[ORAaY] = 4;
opcodeCycles[ORAiX] = 6;
opcodeCycles[ORAiY] = 5;
opcodeCycles[ROL] = 2;
opcodeCycles[ROLzp] = 5;
opcodeCycles[ROLzpX] = 6;
opcodeCycles[ROLa] = 6;
opcodeCycles[ROLaX] = 7;
opcodeCycles[ROR] = 2;
opcodeCycles[RORzp] = 5;
opcodeCycles[RORzpX] = 6;
opcodeCycles[RORa] = 6;
opcodeCycles[RORaX] = 7;
opcodeCycles[RTI] = 6;
opcodeCycles[RTS] = 6;
opcodeCycles[SBCi] = 2;
opcodeCycles[SBCzp] = 3;
opcodeCycles[SBCzpX] = 4;
opcodeCycles[SBCa] = 4;
opcodeCycles[SBCaX] = 4;
opcodeCycles[SBCaY] = 4;
opcodeCycles[SBCiX] = 6;
opcodeCycles[SBCiY] = 5;
opcodeCycles[STAzp] = 3;
opcodeCycles[STAzpX] = 4;
opcodeCycles[STAa] = 4;
opcodeCycles[STAaX] = 5;
opcodeCycles[STAaY] = 5;
opcodeCycles[STAiX] = 6;
opcodeCycles[STAiY] = 6;
opcodeCycles[TXS] = 2;
opcodeCycles[TSX] = 2;
opcodeCycles[PHA] = 3;
opcodeCycles[PLA] = 4;
opcodeCycles[PHP] = 3;
opcodeCycles[PLP] = 4;
opcodeCycles[STXzp] = 3;
opcodeCycles[STXzpY] = 4;
opcodeCycles[STXa] = 4;
opcodeCycles[STYzp] = 3;
opcodeCycles[STYzpX] = 4;
opcodeCycles[STYa] = 4;
	
var singleScreen = false;
var fourScreen = false;
var prgBanks, chrBanks;
var prgRam = new Uint8Array(0x2000);

// TODO: GTROM (111), VRC6 (24/26), MMC5 (5)


// Default helper functions for most mapper types
function initPrgBanks(size) {
	
	prgBanks = new Uint8Array(0x8000 / size);
	var shiftAmount = Math.log(size)/Math.log(2);
	var bankMask = size-1;
	mapRead[1] = function(address) {
		if (!(address & 0x8000)) return prgRam[address - 0x6000];
		
		var romAddress = address & 0x7FFF;
		return prgData[(prgBanks[romAddress >> shiftAmount] << shiftAmount) | (romAddress & bankMask)];
	};
	mapWrite[1] = function (address, value) {
		if (!(address & 0x8000)) prgRam[address - 0x6000] = value;
		// No writing to cartridge space by default
	};
}

// Warning: Using this method cause a fairly large performance overhead
function initChrBanks(size, isRam, banks) {

	chrBanks = new Uint8Array(0x2000 / size);
	if (isRam) chrData = new Uint8Array(size * banks);

	var shiftAmount = Math.log(size)/Math.log(2);
	var bankMask = size-1;
	mapChrRead = function(address) {
		return chrData[(chrBanks[address >> shiftAmount] << shiftAmount) | (address & bankMask)];
	};
	mapChrWrite = function() {};
	if (isRam) mapChrWrite = function (address, value) {
		chrData[(chrBanks[address >> shiftAmount] << shiftAmount) | (address & bankMask)] = value;
	};
	getChrColor = function(tileOffset, tileX, isBg) {
		switch (tileX) {
				case 0:
					return ((mapChrRead(tileOffset, isBg) >> 7) & 0x01) | ((mapChrRead(tileOffset+8, isBg) >> 6) & 0x02);
				case 1:
					return ((mapChrRead(tileOffset, isBg) >> 6) & 0x01) | ((mapChrRead(tileOffset+8, isBg) >> 5) & 0x02);
				case 2:
					return ((mapChrRead(tileOffset, isBg) >> 5) & 0x01) | ((mapChrRead(tileOffset+8, isBg) >> 4) & 0x02);
				case 3:
					return ((mapChrRead(tileOffset, isBg) >> 4) & 0x01) | ((mapChrRead(tileOffset+8, isBg) >> 3) & 0x02);
				case 4:
					return ((mapChrRead(tileOffset, isBg) >> 3) & 0x01) | ((mapChrRead(tileOffset+8, isBg) >> 2) & 0x02);
				case 5:
					return ((mapChrRead(tileOffset, isBg) >> 2) & 0x01) | ((mapChrRead(tileOffset+8, isBg) >> 1) & 0x02);
				case 6:
					return ((mapChrRead(tileOffset, isBg) >> 1) & 0x01) | ((mapChrRead(tileOffset+8, isBg)) & 0x02);
				case 7:
					return ((mapChrRead(tileOffset, isBg)) & 0x01) | ((mapChrRead(tileOffset+8, isBg) << 1) & 0x02);
			}
	}
}


	// UxROM
	mappers[2] = function() {
		initPrgBanks(0x4000);
		prgBanks[1] = (prgData.byteLength / 0x4000) - 1; // Fix last bank
		var unrom = new HwRegister(null, function(value) {
			prgBanks[0] = value & 0x0F;
		});
		for (var i = 0x8000; i < 0x10000; i++) {
			hwRegisters[i] = unrom;
		}
	};

	// UNROM 512
	mappers[30] = function() {
		var prgBank = 0, chrBank = 0;
		if (fourScreen && vMirroring) {
			var nts = [
				new Uint8Array(0x400),
				new Uint8Array(0x400),
				new Uint8Array(0x400),
				new Uint8Array(0x400)
			];
			nametables = [nts[0],nts[1],nts[2],nts[3]];
			attributetables = [nts[0].subarray(-0x40),nts[1].subarray(-0x40),nts[2].subarray(-0x40),nts[3].subarray(-0x40)];
		}
		if (fourScreen && !vMirroring) {
			singleScreen = true;
		}
		var chrRamBackup = [new Uint8Array(0x2000), new Uint8Array(0x2000), new Uint8Array(0x2000), new Uint8Array(0x2000)];
		
		var unrom = new HwRegister(null, function(value) {
			chrRamBackup[chrBank].set(ppuMemory.subarray(0, 0x2000));

			prgBank = value & 0x1F;
			chrBank = (value & 0x60) >> 5;
			var ntIndex = (value & 0x80) >> 7;
			if (!fourScreen) {
				singleScreen = ntIndex != true;
				setMirroring();
				if (singleScreen) ntIndex = 0;
			}
			else {
				// TODO: PPU $3000-$3EFF RAM
			}
			if (singleScreen) {
				nametables = [nameTableSources[ntIndex],nameTableSources[ntIndex],nameTableSources[ntIndex],nameTableSources[ntIndex]];
				attributetables = [attrSources[ntIndex],attrSources[ntIndex],attrSources[ntIndex],attrSources[ntIndex]];
			}
			
			cpuMemory.set(prgData.subarray(prgBank*0x4000, (prgBank+1)*0x4000), 0x8000);
			ppuMemory.set(chrRamBackup[chrBank], 0);
		});
		for (var i = 0x8000; i < 0x10000; i++) {
			hwRegisters[i] = unrom;
		}
	};
	
	
	// MMC1
	mappers[1] = function() {
		//initPrgBanks(0x4000);
		//initChrBanks(0x1000);
		//prgBanks[1] = (prgData.byteLength / 0x4000) - 1;
		
		var count = 0;
		var data = 0;
		var separateChr = false;
		var prgMode = 3;
		var prgIndex = 0;
		var chrIndex0 = 0;
		var chrIndex1 = 0;
		function reset() {
			count = 0;
			data = 0;
		}
		function mapperWrite(value) {
			if ((value & 0x80) != 0) {
				reset();
				return;
			}
			data >>= 1;
			data |= (value & 0x01) << 4;
			count++;
		}
		function setPrg() {
			if (prgMode <= 1) {
				var bigIndex = prgIndex & 0b1110;
				cpuMemory.set(prgData.subarray(bigIndex*0x8000, (bigIndex+1)*0x8000), 0x8000);
			}
			else if (prgMode == 2) {
				cpuMemory.set(prgData.subarray(prgIndex*0x4000, (prgIndex+1)*0x4000), 0xC000);
				cpuMemory.set(prgData.subarray(0, 0x4000), 0x8000);
			}
			else if (prgMode == 3) {
				cpuMemory.set(prgData.subarray(prgIndex*0x4000, (prgIndex+1)*0x4000), 0x8000);
				cpuMemory.set(prgData.subarray(-0x4000), 0xC000);
			}
		}
		function setChr() {
			if (separateChr) {
				ppuMemory.set(chrData.subarray(chrIndex0*0x1000, (chrIndex0+1)*0x1000), 0);
				ppuMemory.set(chrData.subarray(chrIndex1*0x1000, (chrIndex1+1)*0x1000), 0x1000);
			}
			else {
				var chrIndex = (chrIndex0 & 0b11110);
				ppuMemory.set(chrData.subarray(chrIndex0*0x1000, (chrIndex0+2)*0x1000), 0);
			}
		}
		var ctrl = new HwRegister(null, function(value) {
			mapperWrite(value);
			if (count != 5) return;
			var mirroring = data & 0x03;
			vMirroring = (mirroring == 2);
			setMirroring();
			singleScreen = false;
			
			if (mirroring == 0) {
				singleScreen = true;
				nametables = [nameTableSources[1],nameTableSources[1],nameTableSources[1],nameTableSources[1]];
				attributetables = [attrSources[1],attrSources[1],attrSources[1],attrSources[1]];
			}
			if (mirroring == 1) {
				singleScreen = true;
				nametables = [nameTableSources[0],nameTableSources[0],nameTableSources[0],nameTableSources[0]];
				attributetables = [attrSources[0],attrSources[0],attrSources[0],attrSources[0]];
			}
			separateChr = ((data & 0x10) != 0);
			prgMode = (data & 0b01100) >> 2;
			setPrg();
			setChr();
			reset();
		});
		var chrb0 = new HwRegister(null, function(value) {
			mapperWrite(value);
			if (count != 5) return;

			chrIndex0 = data;
			setChr();
			reset();
		});
		var chrb1 = new HwRegister(null, function(value) {
			mapperWrite(value);
			if (count != 5) return;

			chrIndex1 = data;
			setChr();
			reset();
		});
		var prgb = new HwRegister(null, function(value) {
			mapperWrite(value);
			if (count != 5) return;
			
			prgIndex = data & 0b01111;
			setPrg();
			reset();
		});
		for (var i = 0x8000; i < 0xA000; i++) {
			hwRegisters[i] = ctrl;
		}
		for (var i = 0xA000; i < 0xC000; i++) {
			hwRegisters[i] = chrb0;
		}
		for (var i = 0xC000; i < 0xE000; i++) {
			hwRegisters[i] = chrb1;
		}
		for (var i = 0xE000; i < 0x10000; i++) {
			hwRegisters[i] = prgb;
		}
	};
	
	// MMC2
	var mapperListener = null;
	mappers[9] = function() {
		cpuMemory.set(prgData.subarray(-0x6000), 0xA000);
		
		var L0 = false, L1 = false;
		var chr00 = 0, chr01 = 0, chr10 = 0, chr11 = 0;
		
		mapperListener = [];
		mapperListener[0x0FD8] = function() { L0 = false; setChr(); };
		mapperListener[0x0FE8] = function() { L0 = true; setChr(); };
		for (var i = 0; i < 8; i++) {
			mapperListener[0x1FD8 + i] = function() { L1 = false; setChr(); };
			mapperListener[0x1FE8 + i] = function() { L1 = true; setChr(); };
		}
		
		function setChr() {
			var chr0 = L0 ? chr01 : chr00;
			var chr1 = L1 ? chr11 : chr10;
			ppuMemory.set(chrData.subarray(chr0*0x1000, (chr0+1)*0x1000), 0);
			ppuMemory.set(chrData.subarray(chr1*0x1000, (chr1+1)*0x1000), 0x1000);
		}

		var prgSelect = new HwRegister(null, function(value) {
			var prgIndex = value & 0x0F;
			cpuMemory.set(prgData.subarray(prgIndex*0x2000, (prgIndex+1)*0x2000), 0x8000);
		});
		var mirroring = new HwRegister(null, function(value) {
			vMirroring = (value & 1) == 0;
			setMirroring();
		});
		
		var chr00Select = new HwRegister(null, function(value) { chr00 = value & 0x1F; setChr(); });
		var chr01Select = new HwRegister(null, function(value) { chr01 = value & 0x1F; setChr(); });
		var chr10Select = new HwRegister(null, function(value) { chr10 = value & 0x1F; setChr(); });
		var chr11Select = new HwRegister(null, function(value) { chr11 = value & 0x1F; setChr(); });
		for (var i = 0xA000; i < 0xB000; i++) hwRegisters[i] = prgSelect;
		for (var i = 0xB000; i < 0xC000; i++) hwRegisters[i] = chr00Select;
		for (var i = 0xC000; i < 0xD000; i++) hwRegisters[i] = chr01Select;
		for (var i = 0xD000; i < 0xE000; i++) hwRegisters[i] = chr10Select;
		for (var i = 0xE000; i < 0xF000; i++) hwRegisters[i] = chr11Select;
		for (var i = 0xF000; i < 0x10000; i++) hwRegisters[i] = mirroring;

	}

	// MMC3 and MMC6
	mappers[68] = mappers[4] = function() {
		var selectedBank = 0;
		var invertChr = false;
		var invertPrg = false;
		var enablePrgRam = true;
		var bankAssignments = new Uint8Array(8);
		
		function setBanks() {
			var secondToLastBank = prgData.subarray(prgData.byteLength - 0x4000, prgData.byteLength - 0x2000);
			
			if (invertPrg) {
				cpuMemory.set(prgData.subarray(bankAssignments[6]*0x2000, (bankAssignments[6]+1)*0x2000), 0xC000);
				cpuMemory.set(secondToLastBank, 0x8000);
			}
			else {
				cpuMemory.set(prgData.subarray(bankAssignments[6]*0x2000, (bankAssignments[6]+1)*0x2000), 0x8000);
				cpuMemory.set(secondToLastBank, 0xC000);
			}
			cpuMemory.set(prgData.subarray(bankAssignments[7]*0x2000, (bankAssignments[7]+1)*0x2000), 0xA000);
			
			if (invertChr) {
				ppuMemory.set(chrData.subarray(bankAssignments[0]*0x400, (bankAssignments[0]+2)*0x400), 0x1000);
				ppuMemory.set(chrData.subarray(bankAssignments[1]*0x400, (bankAssignments[1]+2)*0x400), 0x1800);

				ppuMemory.set(chrData.subarray(bankAssignments[2]*0x400, (bankAssignments[2]+1)*0x400), 0x0000);
				ppuMemory.set(chrData.subarray(bankAssignments[3]*0x400, (bankAssignments[3]+1)*0x400), 0x0400);
				ppuMemory.set(chrData.subarray(bankAssignments[4]*0x400, (bankAssignments[4]+1)*0x400), 0x0800);
				ppuMemory.set(chrData.subarray(bankAssignments[5]*0x400, (bankAssignments[5]+1)*0x400), 0x0C00);
			}
			else {
				ppuMemory.set(chrData.subarray(bankAssignments[0]*0x400, (bankAssignments[0]+2)*0x400), 0x0000);
				ppuMemory.set(chrData.subarray(bankAssignments[1]*0x400, (bankAssignments[1]+2)*0x400), 0x0800);

				ppuMemory.set(chrData.subarray(bankAssignments[2]*0x400, (bankAssignments[2]+1)*0x400), 0x1000);
				ppuMemory.set(chrData.subarray(bankAssignments[3]*0x400, (bankAssignments[3]+1)*0x400), 0x1400);
				ppuMemory.set(chrData.subarray(bankAssignments[4]*0x400, (bankAssignments[4]+1)*0x400), 0x1800);
				ppuMemory.set(chrData.subarray(bankAssignments[5]*0x400, (bankAssignments[5]+1)*0x400), 0x1C00);
			}

		}	
		var mirroring = new HwRegister(null, function(value) {
			value &= 1;
			vMirroring = (value == 0);
			setMirroring();
		});
		var bankSelect = new HwRegister(null, function(value) {
			selectedBank = value & 0b0111;
			invertChr = (value & 0x80) != 0;
			invertPrg = (value & 0x40) != 0;
			enablePrgRam = (value & 0x20) != 0;
			
			setBanks();
		});
		var bankData = new HwRegister(null, function(value) {
			if (selectedBank >= 6) {
				value &= (prgData.byteLength / 0x2000 - 1);
			}
			else {
				value &= (chrData.byteLength / 0x400 - 1);
			}
			bankAssignments[selectedBank] = value;
			
			setBanks();
		});
		var ramProtect = new HwRegister(null, function(value) {
			if (!enablePrgRam) return;
			// TODO: RAM write protect
		});
		var irqLatch = new HwRegister(null, function(value) {
			irqCounter[1] = value;
		});
		var irqReload = new HwRegister(null, function() {
			irqCounter[0] = 0;
		});
		var irqDisable = new HwRegister(null, function() {
			scanlineIrqEnabled = false;
			pendingIrq = false;
		});
		var irqEnable = new HwRegister(null, function() {
			scanlineIrqEnabled = true;
		});
		
		for (var i = 0x8000; i < 0xA000; i += 2) {
			hwRegisters[i] = bankSelect;
		}
		for (var i = 0x8001; i < 0xA000; i += 2) {
			hwRegisters[i] = bankData;
		}
		for (var i = 0xA000; i < 0xC000; i += 2) {
			hwRegisters[i] = mirroring;
		}
		for (var i = 0xA001; i < 0xC000; i += 2) {
			hwRegisters[i] = ramProtect;
		}
		for (var i = 0xC000; i < 0xE000; i += 2) {
			hwRegisters[i] = irqLatch;
		}
		for (var i = 0xC001; i < 0xE000; i += 2) {
			hwRegisters[i] = irqReload;
		}
		for (var i = 0xE000; i < 0x10000; i += 2) {
			hwRegisters[i] = irqDisable;
		}
		for (var i = 0xE001; i < 0x10000; i += 2) {
			hwRegisters[i] = irqEnable;
		}
	};
	var scanlineIrqEnabled = false;
	var irqCounter = new Uint8Array(3); // 0 = actual counter, 1 = MMC3 latch, 2 = MMC5 latch
	
	
	// AxROM
	mappers[7] = function() {
		singleScreen = true;
		var bankSelect = new HwRegister(null, function(value) {
			var nts = (value & 0x10) >> 4;
			nametables = [nameTableSources[nts],nameTableSources[nts],nameTableSources[nts],nameTableSources[nts]];
			attributetables = [attrSources[nts],attrSources[nts],attrSources[nts],attrSources[nts]];

			var bankIndex = value & 7;
			cpuMemory.set(prgData.subarray(bankIndex*0x8000, (bankIndex+1)*0x8000), 0x8000);
		});
		for (var i = 0x8000; i < 0x10000; i++) {
			hwRegisters[i] = bankSelect;
		}
	};
	
	// CNROM
	mappers[3] = function() {
		var bankSelect = new HwRegister(null, function(value) {
			var bankIndex = value & 3;
			ppuMemory.set(chrData.subarray(bankIndex*0x2000, (bankIndex+1)*0x2000), 0);
		});
		for (var i = 0x8000; i < 0x10000; i++) {
			hwRegisters[i] = bankSelect;
		}		
	};
	
	// SunSoft 5/FME-7
	mappers[69] = function() {
		var commands = [];
		var currentCommand = 0;
		var hasPrgRam = false;
		
		function chrBank(bankIndex, bank) {
			bankIndex &= (chrData.byteLength / 0x400 - 1)
			ppuMemory.set(chrData.subarray(bankIndex*0x400, (bankIndex+1)*0x400), bank * 0x400);
		};
		var prgRamBackup = new Uint8Array(0x2000);
		function prgBank(value, bank) {
			var test = frame;
			var bankIndex = value & 0x3F & (prgData.byteLength / 0x2000 - 1);
			bank &= 3;
			var prgBank = prgData.subarray(bankIndex*0x2000, (bankIndex+1)*0x2000);
			if (bank == 0) {
				if (hasPrgRam) prgRamBackup.set(cpuMemory.subarray(0x6000, 0x8000));
				hasPrgRam = (value & 0x40) != 0;
				cpuMemory.set(hasPrgRam ? prgRamBackup : prgBank, 0x6000);
			}
			else {
				cpuMemory.set(prgBank, 0x6000 + (bank * 0x2000));
			}
		};
		function mirroring(value) {
			value &= 3;
			vMirroring = value == 0;
			setMirroring();
			singleScreen = false;
			if ((value & 2) != 0) {
				singleScreen = true;
				var nts = (value & 1);
				nametables = [nameTableSources[nts],nameTableSources[nts],nameTableSources[nts],nameTableSources[nts]];
				attributetables = [attrSources[nts],attrSources[nts],attrSources[nts],attrSources[nts]];
			}
		}
		function irqControl(value) {
			cycleIrqEnabled = (value & 0x01) != 0;
			cycleCountEnabled = (value & 0x80) != 0;
			pendingIrq = false;
		}
		function irqLow(value) { cycleCounterBytes[0] = value; }
		function irqHigh(value) { cycleCounterBytes[1] = value; }
		
		commands[0] = commands[1] = commands[2] = commands[3] = commands[4] = commands[5] = commands[6] = commands[7] = chrBank;
		commands[8] = commands[9] = commands[10] = commands[11] = prgBank;
		commands[12] = mirroring;
		commands[13] = irqControl;
		commands[14] = irqLow;
		commands[15] = irqHigh;
		
		var cmd = new HwRegister(null, function(value) {
			currentCommand = value & 0x0F;
		});
		var param = new HwRegister(null, function(value) {
			if (commands[currentCommand]) commands[currentCommand](value, currentCommand);
		});
		
		for (var i = 0x8000; i < 0xA000; i++) {
			hwRegisters[i] = cmd;
		}
		for (var i = 0xA000; i < 0xC000; i++) {
			hwRegisters[i] = param;
		}
	};
	var cycleIrqEnabled = false;
	var cycleCountEnabled = false;
	var cycleCounterBuffer = new ArrayBuffer(2);
	var cycleCounterBytes = new Uint8Array(cycleCounterBuffer);
	var cycleCounter = new Uint16Array(cycleCounterBuffer);

	// GTROM
	mappers[111] = function() {
		var extraNametables = [
			new Uint8Array(0x400),
			new Uint8Array(0x400),
			new Uint8Array(0x400),
			new Uint8Array(0x400)
		];
		var chrRamBackup = [new Uint8Array(0x2000), new Uint8Array(0x2000)];
		var chrRamIndex = 0;
		var bankSelect = new HwRegister(null, function(value) {
			var prgIndex = value & 0x0F & (prgData.byteLength / 0x8000 - 1);
			cpuMemory.set(prgData.subarray(prgIndex*0x8000, (prgIndex+1)*0x8000), 0x8000);

			chrRamBackup[chrRamIndex].set(ppuMemory.subarray(0, 0x2000));
			chrRamIndex = (value >> 4) & 1;
			ppuMemory.set(chrRamBackup[chrRamIndex], 0);

			var nts = ((value >> 5) & 1) == 0 ? nameTableSources : extraNametables;
			nametables = [nts[0],nts[1],nts[2],nts[3]];
			attributetables = [nts[0].subarray(-0x40),nts[1].subarray(-0x40),nts[2].subarray(-0x40),nts[3].subarray(-0x40)];
		});
		
		for (var i = 0x5000; i < 0x6000; i++) {
			hwRegisters[i] = bankSelect;
		}
		for (var i = 0x7000; i < 0x8000; i++) {
			hwRegisters[i] = bankSelect;
		}
		bankSelect.store(0);
	};
	
	var mmc5ScanlineIrqEnabled = false;
	mappers[5] = function() {
		
		var prgMask = (prgData.byteLength / 0x2000) - 1;
		var prgRamMask = (0x40000 / 0x2000) - 1;
		var chrMask = (chrData.byteLength / 0x400) - 1;
		
		var mmc5Ram = new Uint8Array(0x40000);
		var fillNametable = new Uint8Array(0x400);
		var fillNametableAttributes = new Uint8Array(fillNametable.buffer, 0x3C0, 0x40);
		bgChrMemory = new Uint8Array(0x2000); // ghetto banking for performance reasons
		
		var prgMode = 0, chrMode = 0;
		var prgIndex = new Uint8Array(5);
		var chrIndex = new Uint8Array(8);
		var bgChrIndex = new Uint8Array(8);
		var prgIndexRam = new Uint8Array(5);
		
		initChrBanks(0x400);
		initPrgBanks(0x2000);

		var bgChrBanks = new Uint8Array(8);

		mapChrRead = function(address, isBg) {
			var bank = isBg && tallSprites ? bgChrBanks[address >> 10] : chrBanks[address >> 10];
			return chrData[(bank << 10) | (address & 0x3ff)];
		};
		
		/*
PRG RAM mode: (needs to be extended to take extended RAM into consideration, or CV3 will break)
		prgBanks = new Uint8Array(4);
		prgRam = new Uint8Array(mmc5Ram.buffer, 0, 0x2000);
		var shiftAmount = 13;
		var bankMask = 0x1FFF;
		mapRead[1] = function(address) {
			if (!(address & 0x8000)) return prgRam[address - 0x6000];
			
			var romAddress = address & 0x7FFF;
			var slot = romAddress >> shiftAmount;
			if (prgIndexRam[slot]) return mmc5Ram[((prgBanks[slot] & prgRamMask) << shiftAmount) | (romAddress & bankMask)];
			return prgData[(prgBanks[slot] << shiftAmount) | (romAddress & bankMask)];
		};
		mapWrite[1] = function (address, value) {
			if (!(address & 0x8000)) prgRam[address - 0x6000] = value;
			var romAddress = address & 0x7FFF;
			var slot = romAddress >> shiftAmount;
			if (prgIndexRam[slot]) mmc5Ram[((prgBanks[slot] & prgRamMask) << shiftAmount) | (romAddress & bankMask)] = value;
		};*/
		
		setNametables(vMirroring ? 0x44 : 0x50);
		setPrgIndex(4, 0xFF);
		
		function setPrgMode(value) {
			prgMode = value & 3;
			setPrg();
		}
		function setChrMode(value) {
			chrMode = value & 3;
			setChr();
		}
		function setPrgIndex(slot, index) {
			if (slot > 0 && slot < 4) prgIndexRam[slot] = (index & 0x80) != 0
			prgIndex[slot] = index & 0x7F & prgMask;
			setPrg();
		}
		function setChrIndex(slot, index) {
			chrIndex[slot] = index & chrMask;
			setChr();
		}
		function setBgChrIndex(slot, index) {
			bgChrIndex[slot] = index & chrMask;
			setChr();
		}
		
		function setPrg() {
			prgRam = new Uint8Array(mmc5Ram.buffer, 0x2000 * prgIndex[0], 0x2000);
			// TODO: RAM slots (override PRG read)
			switch (prgMode) {
				case 0:
					prgBanks[0] = (prgIndex[4] & 0xFC);
					prgBanks[1] = (prgIndex[4] & 0xFC) | 1;
					prgBanks[2] = (prgIndex[4] & 0xFC) | 2;
					prgBanks[3] = (prgIndex[4] & 0xFC) | 3;
					break;
				case 1:
					prgBanks[0] = (prgIndex[2] & 0xFE);
					prgBanks[1] = (prgIndex[2] & 0xFE) | 1;
					prgBanks[2] = (prgIndex[4] & 0xFE);
					prgBanks[3] = (prgIndex[4] & 0xFE) | 1;
					break;
				case 2:
					prgBanks[0] = (prgIndex[2] & 0xFE);
					prgBanks[1] = (prgIndex[2] & 0xFE) | 1;
					prgBanks[2] = prgIndex[3];
					prgBanks[3] = prgIndex[4];
					break;
				case 3:
					prgBanks[0] = prgIndex[1];
					prgBanks[1] = prgIndex[2];
					prgBanks[2] = prgIndex[3];
					prgBanks[3] = prgIndex[4];
					break;
			}
		}
		function setChr() {
			
			switch (chrMode) {
				case 0:
					chrBanks[0] = (chrIndex[7] << 3);
					chrBanks[1] = (chrIndex[7] << 3) | 1;
					chrBanks[2] = (chrIndex[7] << 3) | 2;
					chrBanks[3] = (chrIndex[7] << 3) | 3;
					chrBanks[4] = (chrIndex[7] << 3) | 4;
					chrBanks[5] = (chrIndex[7] << 3) | 5;
					chrBanks[6] = (chrIndex[7] << 3) | 6;
					chrBanks[7] = (chrIndex[7] << 3) | 7;
					
					bgChrBanks[0] = (bgChrIndex[3] << 3);
					bgChrBanks[1] = (bgChrIndex[3] << 3) | 1;
					bgChrBanks[2] = (bgChrIndex[3] << 3) | 2;
					bgChrBanks[3] = (bgChrIndex[3] << 3) | 3;
					bgChrBanks[4] = (bgChrIndex[3] << 3) | 4;
					bgChrBanks[5] = (bgChrIndex[3] << 3) | 5;
					bgChrBanks[6] = (bgChrIndex[3] << 3) | 6;
					bgChrBanks[7] = (bgChrIndex[3] << 3) | 7;
					break;
				case 1:
					chrBanks[0] = (chrIndex[3] << 2);
					chrBanks[1] = (chrIndex[3] << 2) | 1;
					chrBanks[2] = (chrIndex[3] << 2) | 2;
					chrBanks[3] = (chrIndex[3] << 2) | 3;
					chrBanks[4] = (chrIndex[7] << 2);
					chrBanks[5] = (chrIndex[7] << 2) | 1;
					chrBanks[6] = (chrIndex[7] << 2) | 2;
					chrBanks[7] = (chrIndex[7] << 2) | 3;
					
					bgChrBanks[0] = (bgChrIndex[3] << 2);
					bgChrBanks[1] = (bgChrIndex[3] << 2) | 1;
					bgChrBanks[2] = (bgChrIndex[3] << 2) | 2;
					bgChrBanks[3] = (bgChrIndex[3] << 2) | 3;
					bgChrBanks[4] = (bgChrIndex[3] << 2);
					bgChrBanks[5] = (bgChrIndex[3] << 2) | 1;
					bgChrBanks[6] = (bgChrIndex[3] << 2) | 2;
					bgChrBanks[7] = (bgChrIndex[3] << 2) | 3;
					break;
				case 2:
					chrBanks[0] = (chrIndex[1] << 1);
					chrBanks[1] = (chrIndex[1] << 1) | 1;
					chrBanks[2] = (chrIndex[3] << 1);
					chrBanks[3] = (chrIndex[3] << 1) | 1;
					chrBanks[4] = (chrIndex[5] << 1);
					chrBanks[5] = (chrIndex[5] << 1) | 1;
					chrBanks[6] = (chrIndex[7] << 1);
					chrBanks[7] = (chrIndex[7] << 1) | 1;
					
					bgChrBanks[0] = (bgChrIndex[1] << 1);
					bgChrBanks[1] = (bgChrIndex[1] << 1) | 1;
					bgChrBanks[2] = (bgChrIndex[3] << 1);
					bgChrBanks[3] = (bgChrIndex[3] << 1) | 1;
					bgChrBanks[4] = (bgChrIndex[1] << 1);
					bgChrBanks[5] = (bgChrIndex[1] << 1) | 1;
					bgChrBanks[6] = (bgChrIndex[3] << 1);
					bgChrBanks[7] = (bgChrIndex[3] << 1) | 1;
					break;
				case 3:
					chrBanks[0] = chrIndex[0];
					chrBanks[1] = chrIndex[1];
					chrBanks[2] = chrIndex[2];
					chrBanks[3] = chrIndex[3];
					chrBanks[4] = chrIndex[4];
					chrBanks[5] = chrIndex[5];
					chrBanks[6] = chrIndex[6];
					chrBanks[7] = chrIndex[7];

					bgChrBanks[0] = bgChrIndex[0];
					bgChrBanks[1] = bgChrIndex[1];
					bgChrBanks[2] = bgChrIndex[2];
					bgChrBanks[3] = bgChrIndex[3];
					bgChrBanks[4] = bgChrIndex[0];
					bgChrBanks[5] = bgChrIndex[1];
					bgChrBanks[6] = bgChrIndex[2];
					bgChrBanks[7] = bgChrIndex[3];
					break;
			}
			bgChrMemory.set(chrData.subarray(bgChrBanks[0]*0x400, (bgChrBanks[0]+1)*0x400), 0x0000);
			bgChrMemory.set(chrData.subarray(bgChrBanks[1]*0x400, (bgChrBanks[1]+1)*0x400), 0x0400);
			bgChrMemory.set(chrData.subarray(bgChrBanks[2]*0x400, (bgChrBanks[2]+1)*0x400), 0x0800);
			bgChrMemory.set(chrData.subarray(bgChrBanks[3]*0x400, (bgChrBanks[3]+1)*0x400), 0x0C00);
			bgChrMemory.set(chrData.subarray(bgChrBanks[4]*0x400, (bgChrBanks[4]+1)*0x400), 0x1000);
			bgChrMemory.set(chrData.subarray(bgChrBanks[5]*0x400, (bgChrBanks[5]+1)*0x400), 0x1400);
			bgChrMemory.set(chrData.subarray(bgChrBanks[6]*0x400, (bgChrBanks[6]+1)*0x400), 0x1800);
			bgChrMemory.set(chrData.subarray(bgChrBanks[7]*0x400, (bgChrBanks[7]+1)*0x400), 0x1C00);
		}
		function setNametable(nti, mapping) {
			switch (mapping) {
				case 0:
				case 1:
					nametables[nti] = nameTableSources[mapping];
					attributetables[nti] = attrSources[mapping];
					break;
				case 2:
					// TODO: extended RAM
					nametables[nti] = nameTableSources[0];
					attributetables[nti] = attrSources[0];
					break;
				case 3:
					nametables[nti] = fillNametable;
					attributetables[nti] = fillNametableAttributes;
					break;
			}
		}
		function setNametables(value) {
			setNametable(0, value & 3);
			value >>= 2;
			setNametable(1, value & 3);
			value >>= 2;
			setNametable(2, value & 3);
			value >>= 2;
			setNametable(3, value & 3);
		}
		
		function irqLatch(value) {
			irqCounter[2] = value;
		}
		var irqStatus = new HwRegister(function() {
			var returnValue = (pendingIrq == 2 ? 0x0 : 0) | (((showBG || showSprites) && scanline < 240 && pixelOnScanline < 259) ? 0x40 : 0);
			pendingIrq = false;
			return returnValue;
		}, function (value) {
			mmc5ScanlineIrqEnabled = (value & 0x80) != 0;
		});
		
		hwRegisters[0x5100] = new HwRegister(null, setPrgMode);
		hwRegisters[0x5101] = new HwRegister(null, setChrMode);
		// TODO: prg ram protect
		// TODO: extended ram
		hwRegisters[0x5105] = new HwRegister(null, setNametables);
		hwRegisters[0x5106] = new HwRegister(null, function(value) { fillNametable.fill(value, 0, 0x3C0); });
		hwRegisters[0x5107] = new HwRegister(null, function(value) { fillNametable.fill(value, 0x3C0); });

		hwRegisters[0x5113] = new HwRegister(null, function(value) { setPrgIndex(0, value); });
		hwRegisters[0x5114] = new HwRegister(null, function(value) { setPrgIndex(1, value); });
		hwRegisters[0x5115] = new HwRegister(null, function(value) { setPrgIndex(2, value); });
		hwRegisters[0x5116] = new HwRegister(null, function(value) { setPrgIndex(3, value); });
		hwRegisters[0x5117] = new HwRegister(null, function(value) { setPrgIndex(4, value); });

		hwRegisters[0x5120] = new HwRegister(null, function(value) { setChrIndex(0, value); });
		hwRegisters[0x5121] = new HwRegister(null, function(value) { setChrIndex(1, value); });
		hwRegisters[0x5122] = new HwRegister(null, function(value) { setChrIndex(2, value); });
		hwRegisters[0x5123] = new HwRegister(null, function(value) { setChrIndex(3, value); });
		hwRegisters[0x5124] = new HwRegister(null, function(value) { setChrIndex(4, value); });
		hwRegisters[0x5125] = new HwRegister(null, function(value) { setChrIndex(5, value); });
		hwRegisters[0x5126] = new HwRegister(null, function(value) { setChrIndex(6, value); });
		hwRegisters[0x5127] = new HwRegister(null, function(value) { setChrIndex(7, value); });

		hwRegisters[0x5128] = new HwRegister(null, function(value) { setBgChrIndex(0, value); });
		hwRegisters[0x5129] = new HwRegister(null, function(value) { setBgChrIndex(1, value); });
		hwRegisters[0x512A] = new HwRegister(null, function(value) { setBgChrIndex(2, value); });
		hwRegisters[0x512B] = new HwRegister(null, function(value) { setBgChrIndex(3, value); });
		
		hwRegisters[0x5203] = new HwRegister(null, irqLatch);
		hwRegisters[0x5204] = irqStatus;
	}
/* 

Introduces a very simple api off the `window.emu` object. Allows for getting/setting a few common things.

*/

var Api = {};
Api.getSram = function() {
    return cpuMemory.subarray(0x6000, 0x8000);
};

Api.setSramValue = function(addr, value) {
    cpuMemory.set[0x6000+addr] = value;
};

Api.setSramValues = function(addr, values) {
    for (var i = 0; i < values.length; i++) {
        cpuMemory[0x6000+addr+i] = values[i];
    }
};

Api.addOpcodeHook = function(opcode, hookfn) {
    var _origCb = opcodes[opcode] || function(){}

    opcodes[opcode] = function() {
        var cpu = {
            regA: cpuRegisters[A],
            regX: cpuRegisters[X],
            regY: cpuRegisters[Y]
        };
        hookfn(cpu, cpuMemory);
        _origCb()
    };
}		
	var prgData;
	var chrData;
	var chrRam = false;
	var saveRam = false;
	var gameId;
	function LoadNRom(data, prgChunks, chrChunks) {

		cpuMemory.fill(0);
		ppuMemory.fill(0);
	
		prgData = data.subarray(0, prgChunks * 0x4000);
		if (prgChunks >= 2) {
			cpuMemory.set(prgData.subarray(-0x8000), 0x8000);
		}
		if (prgChunks == 1) {
			cpuMemory.set(prgData, 0x8000);
			cpuMemory.set(prgData, 0xC000);
		}
		if (chrChunks) {
			chrRam = false;
			chrData = data.subarray(-0x2000 * chrChunks);
		}
		else {
			chrRam = true;
			chrData = ppuMemory.subarray(0 * 0x2000);
		}
		ppuMemory.set(chrData.subarray(0, 0x2000), 0);
		loaded = true;
	}
	
	var openBus = 0; // TODO!
	function readCpu(address) {
		if (!(address & 0xE000)) return cpuMemory[address & 0x07FF]; // Mirrors RAM
		// The rest is registers. If no register is available, use open bus behavior
		return openBus;
	}
	function writeCpu(address, value) {
		if (!(address & 0xE000)) cpuMemory[address & 0x07FF] = value;
	}
	function readCart(address) {
		return cpuMemory[address]; // Dummy function for NROM, etc.
		// TODO: openBus below 0x8000 unless mapper allows it
	}
	function writeCart(address, value) {
		cpuMemory[address] = value;
	}
	function vector(index) {
		return mapRead[1](0xfffa + (index * 2)) | (mapRead[1](0xfffa + 1 + (index * 2)) << 8);
	}
	function readChr(address) {
		return ppuMemory[address];
	}
	function writeChr(address, value) {
		if (chrRam) ppuMemory[address] = value;
	}
	
	
	
	function LoadRomData(data, filename) {
		
		if (loaded) {
			window.cancelAnimationFrame(timing);
		}
		
		//var newRom = new Uint8Array(rom.byteLength + (128 * 1024));
		//	newRom.set(new Uint8Array(rom), 0);
		var header = new Uint8Array(data, 0, 0x10);
		var romData = new Uint8Array(data, 0x10);
		
		var prgChunks = header[4];
		var chrChunks = header[5];
		singleScreen = false;
		vMirroring = (header[6] & 1) != 0;
		setMirroring();
		saveRam = (header[6] & 2) != 0;
		fourScreen = (header[6] & 8) != 0;
		var mapperId = (header[6] & 0xf0) >> 4;
		mapperId |= header[7] & 0xf0;
		
		mapRead[0] = readCpu;
		mapRead[1] = readCart;
		mapWrite[0] = writeCpu;
		mapWrite[1] = writeCart;
		mapChrRead = readChr;
		mapChrWrite = writeChr;
		
		var hwRegisters = {};
		setPpuRegisters();
		apu.setRegisters();
		switch (mapperId) {
			case 0:
				LoadNRom(romData, prgChunks, chrChunks);
				break;
			default:
				LoadNRom(romData, prgChunks, chrChunks);
				var mapper = mappers[mapperId];
				if (!mapper) {
					alert('Unsupported mapper :(');
					return false;
				}
				mapper(mapperId);
		}
		gameId = filename;
		
		return true;
	}
	function setMirroring() {
		nametables = vMirroring
			? [nameTableSources[0], nameTableSources[1], nameTableSources[0], nameTableSources[1]]
			: [nameTableSources[0], nameTableSources[0], nameTableSources[1], nameTableSources[1]];
		attributetables = vMirroring
			? [attrSources[0], attrSources[1], attrSources[0], attrSources[1]]
			: [attrSources[0], attrSources[0], attrSources[1], attrSources[1]];
	}
	
	var useGl = false; // GL is slower(!) but allows use of shaders
	var shaderScript;
	var context; // 256x240 backbuffer
	var output;
	var debug = false;
	var glNt;
	var glChr;
	
	var xhr = new XMLHttpRequest();
	xhr.open('GET', 'crt.glsl', true);
	xhr.onload = function(e) {
		shaderScript = xhr.responseText;
		if (useGl) initGl();
	};
	xhr.send(null);
	
	function initGl() {
		if (!shaderScript) return;
		var scale = 3;
		context = GlEngine(256*scale, 240*scale, shaderScript);
		context.AddTextureData('output', outputBytes, 256, 256);
		context.SpriteBatch();
		context.DrawSprite('output', 0, 256*3, 0, 0, 256, 256, false, false, scale);
		context.SetCustomUniforms({
			//'FrameDirection': 1 ,
			//'FrameCount': 1 ,
			'OutputSize': [256*scale, 256*scale],
			'TextureSize': [256, 256],
			'InputSize': [256, 256],
			'MVPMatrix': new Float32Array([
				2,0,0,0,
				0,-256.0*2/240,0,0,
				0,0,2,0,
				-256*scale,256*scale,0,256*scale
			])
		});
		context.Render(); // Buffer a draw of the "output" texture, so we can quickly repeat it
	}
	function initSoftRender() {
		context = window.document.createElement('canvas').getContext('2d');
		context.canvas.width = 256;
		context.canvas.height = 240;
		context.imageData = new ImageData(outputColorEdit, 256, 256);
	}
	
	function Run(canvas, debugmode) {
		output = canvas.getContext('2d');

		if (!loaded) return;
		debug = (debugmode == true);

		if (useGl) {
			initGl();
		}
		else {
			initSoftRender();
		}
		if (debug) {
			glNt = GlEngine(512, 480);
			glNt.AddTextureData('nt', ntBytes, 512, 512);
			canvas.parentNode.appendChild(glNt.Canvas());
			glNt.Canvas().className = 'nametable';

			glChr = GlEngine(128, 256);
			glChr.AddTextureData('chr', spriteBytes, 128, 256);
			canvas.parentNode.appendChild(glChr.Canvas());
			glChr.Canvas().className = 'chr';
		}

		if (saveRam) {
			window.onbeforeunload = storeSram;
			loadSram();
		}
		else {
			window.onbeforeunload = undefined;
		}
		configureKeys();
		cycleCounts.fill(0);
		ppuReset();
		apu.init();
		
		pc[0] = vector(RESET);

		currentCycleCount = 0;
		//setInterval(ppuAdvanceFrame, 1000 / 60);
		runPc();
	};
	
	function loadSram() {
		if (window.localStorage[gameId]) {
			var gameData = JSON.parse(window.localStorage[gameId]);
			if (gameData.sram) cpuMemory.set(decodeBytes(gameData.sram), 0x6000);
		}
	}
	function storeSram() {
		window.localStorage[gameId] = JSON.stringify({
			sram: encodeBytes(cpuMemory.subarray(0x6000, 0x8000))
		});
	}
	function encodeBytes(bytes) {
		var string = '';
		for (var i = 0; i < bytes.length; i++) {
			string += String.fromCharCode(bytes[i]);
		}
		return (string);
	}
	function decodeBytes(string) {
		var bytes = new Uint8Array(0x2000);
		for (var i = 0; i < string.length; i++) {
			bytes[i] = string.charCodeAt(i);
		}
		return bytes;
	}
	
	function Pause() {
		if (loaded) {
			Mute();
			window.cancelAnimationFrame(timing);
			timing = null;
		}
	}
	function Resume() {
		if (loaded) {
			Unmute();
			if (timing) window.cancelAnimationFrame(timing);
			timing = window.requestAnimationFrame(ppuAdvanceFrame);
		}
	}
	var debugCycleCount = 0;
	var trace = [];
	var breakpoints = [];

	var timing;
	var currentCycleCount;
	var pendingIrq = false;
	var pendingNmi = false;
	var frameEnded = false;
	
	function runPc() {
		timing = window.requestAnimationFrame(ppuAdvanceFrame);
		frameEnded = false;
		
		pcLoop:
		while (true) {

			/*
			// TODO: only debug
			var debug = cpuRegisters;
			var debug2 = ppuMemory;
			var debug3 = stack;
			var debug4 = scanline;
			var debug5 = pixelOnScanline;
			var debug6 = currentY;
			trace.push(pc[0].toString(16).toUpperCase());
			if (trace.length > 1000) trace = trace.slice(-200);
			
			//if (breakpoints.indexOf(pc[0]) >= 0) debugger;
			// debug end
			*/
			
			if (pendingNmi) {
				jumpToIrq(NMI);
				pendingNmi = false;
			}
			else if (pendingIrq && !interruptFlag) jumpToIrq(IRQ);
			
			//if (pc[0] == 0 || pc[0] == 0x85DF) debugger;
			var opcode = mapRead[pc[0] & 0xC000 ? 1 : 0](pc[0]);
			pc[0]++;
			var runOpcode = opcodes[opcode];
			
			if (!runOpcode) {
				if (timing) window.cancelAnimationFrame(timing);
				alert('Unidentified opcode: $' + opcode.toString(16).toUpperCase() + '\nAt $' + (pc[0]-1).toString(16).toUpperCase());
				console.log(trace);
				return;
			}
			
			if (opcodeCycles[opcode]) currentCycleCount += opcodeCycles[opcode];
			cycleCounts[0] += currentCycleCount;
			cycleCounts[1] += currentCycleCount;
			cycleCounts[2] += currentCycleCount;
			currentCycleCount = 0;
			while (cycleCounts[1] > 0) {
				cycleCounts[1]--;
				ppuPixel();
				ppuPixel();
				ppuPixel();
			}
			while (cycleCounts[0] > 1) {
				cycleCounts[0] -= 2
				apu.tick(1);
			}
			
			runOpcode();
			
			//if (opcodeCycles[opcode]) currentCycleCount += opcodeCycles[opcode];
			cycleCounts[0] += currentCycleCount;
			cycleCounts[1] += currentCycleCount;
			cycleCounts[2] += currentCycleCount;
			currentCycleCount = 0;
			
			// Full scanline mode
//			if (cycleCounts[1] > 113.6666) {
//				cycleCounts[1] -= 113.6666;
//				ppuScanline();
//			}
			if (cycleCountEnabled && cycleCounter[0] > 0) {
				var newCount = cycleCounter[0] - cycleCounts[2];
				if (newCount <= 0) {
					newCount == 0;
					if (cycleIrqEnabled) pendingIrq = true;
				}
				cycleCounter[0] = newCount;
			}
			cycleCounts[2] = 0;
			/*
			while (cycleCounts[1] > 0) {
				cycleCounts[1]--;
				ppuPixel();
				ppuPixel();
				ppuPixel();
			}
			while (cycleCounts[0] > 1) {
				cycleCounts[0] -= 2
				apu.tick(1);
			}*/
			
//			if (cycleCounts[0] > 29781) { // Frame timing
//				cycleCounts[0] -= 29781;
//				//setTimeout(ppuAdvanceFrame, 1000 / 60);
//				break;
//			}
			if (frameEnded) break;
		}
	}
	
	function jumpToIrq(irqVector) {
		currentCycleCount += 7;
		push(pcByte[1]);
		push(pcByte[0]);
		push(getFlags())
		interruptFlag = true;
		pc[0] = vector(irqVector);
	}
	function returnFromIrq() {
		setFlags(pull());
		pcByte[0] = pull();
		pcByte[1] = pull();
		interruptFlag = false;
	}
	function getFlags(isBreak) {
		return 0x20 // Interrupt flag
		| (c ? 0x01 : 0)
		| (z ? 0x02 : 0)
		| (interruptFlag ? 0x04 : 0)
//		| (DECIMAL ? 0x08 : 0)
		| (isBreak ? 0x10 : 0)
		| (v ? 0x40 : 0)
		| (n ? 0x80 : 0);
	}
	function setFlags(value) {
		c = ((value & 0x01) != 0);
		z = ((value & 0x02) != 0);
		interruptFlag = ((value & 0x04) != 0);
		v = ((value & 0x40) != 0);
		n = ((value & 0x80) != 0);
	}
	
	function HwRegister(read, store) {
		this.read = read;
		this.store = store;
	}
	
	
	
	
	var nativeFps = -1;
	function detectFps(callback) {

		if (!window.requestAnimationFrame) {
			nativeFps = 0;
			if (callback) callback();
			return;
		}

		var testedFrames = 0;
		var startTime;
		var testSize = 60;

		function firstFrame(time) {
			startTime = time;
			window.requestAnimationFrame(runFrame);
		};
		function runFrame(time) {
			testedFrames++;
			if (testedFrames == testSize) {
				nativeFps = (1000 * testedFrames / (time - startTime));
				if (callback) callback();
				return;
			}
			window.requestAnimationFrame(runFrame);
		};
		window.requestAnimationFrame(function () { window.requestAnimationFrame(firstFrame); }); // Skip unreliable first frame
	};
	detectFps();

	function PreloadFile(file) {
		preloadedData = {file: file};
	}

	function PreloadUrl(url, romName) {
		preloadedData = {url: url, romName: romName};
	}

	function StartPreloadedGame() {
		if (preloadedData.file) {
			StartFromFile(preloadedData.file);
		} else if (preloadedData.url) {
			StartFromUrl(preloadedData.url, preloadedData.romName);
		} else {
			// Nothing to do here
			$('#clickMe').hide();
			$('.emulator').show();
		}
	}
	
	// NOTE: This isn't very clean, and likely needs some tweaking if it's to go back into master.
	// If nothing else, probably want to take the canvas as an input.. maybe error handling and volume too.
	function StartFromFile(file) {
		
		if (!file.name.match(/\.nes$/i)) {
			alert('invalid file');
			return;
		}
		var reader = new FileReader();
		reader.onload = function (e) {

			setTimeout(function() { 

				SetMasterVolume($('[type=range]').val() / 100)
				if (!LoadRomData(e.target.result, file)) {
					return;
				}
				//$('.button.open').remove();
				Run($('canvas')[0], window.isDebug);
			});

		};
		reader.readAsArrayBuffer(file);
		$('#clickMe').hide();
		$('.emulator').show();

	}

	function StartFromUrl(url, romName) {
		var oReq = new XMLHttpRequest();
		oReq.open("GET", url, true);
		oReq.responseType = "arraybuffer";

		oReq.onload = function (oEvent) {
			var arrayBuffer = oReq.response; // Note: not oReq.responseText
			if (arrayBuffer) {
				SetMasterVolume($('[type=range]').val() / 100)
				if (!LoadRomData(arrayBuffer, romName)) {
					return;
				}
				Run($('canvas')[0], window.isDebug);
			}
		};

		oReq.send(null);
		$('#clickMe').hide();
		$('.emulator').show();
	}


	// Initialize audio context when the user touches the screen the first time, to fix weird ios issues
	function audioInitializer() {
		// iOS 9
		document.removeEventListener('touchend', audioInitializer);
		apu.init();
	}
	// iOS 9
	document.addEventListener('touchend', audioInitializer);	

	
	
	
	
	var emulator = {
		
		loadRomData: LoadRomData,
		run: Run,
		pause: Pause,
		resume: Resume,
		volume: SetMasterVolume,
		useMouse: UseMouse,
		isPlaying: function () { return loaded; },
		buttonConfig: ButtonConfig,
		controller: Controller,
		render: renderFrame,
		enableShader: function(shaderScript) { useGl = true; initGl(); },
		disableShader: function() { useGl = false; initSoftRender(); },
		Api: Api,
		startFromUrl: StartFromUrl,
		startFromFile: StartFromFile,
		preloadFile: PreloadFile,
		preloadUrl: PreloadUrl,
		startPreloadedGame: StartPreloadedGame
		
		
	};

	
	
	return emulator;
})();


