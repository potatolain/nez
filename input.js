
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
p1Buttons[keySPACE] = ABUTTON;
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