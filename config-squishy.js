// This file sets configuration for the emulator, allowing you to customize it to play a single game.
// To use it, copy this file from `config.example.js` to `config.js` and change the configuration.

window.EMULATOR_CONFIG = {

    // Put the URL to a rom here, and the emulator will automatically start it when the page is first loaded. 
    // If you just put a file name, then put the rom file in the same folder as this file.
    game: "squishy.nes",
    // game: "game.nes"`
    
    // Set this to true to make NEZ act like the emulator used on the gba - the NES classic series, as well
    // as e-reader roms.
    // NOTE: This feature is pretty clunky, use it with care!
    // FIXME: Disable this by default
    pretendToBeGba: true,

    // Settings for the pretty version of the emulator that shows game description, etc... (index.html)
    HTML: {

        // Set this to a text string to show a description about your game (not shown in embedded view)
        // This will show up between the controls and the emulator description. Html is supported!
        // IMPORTANT: If you set this, be sure to set the title below too!
        gameDescription: null,

        // Set this to the title of your game, and it will show up instead of the words "This Game" in the description area.
        gameTitle: null,

        // Show the "Click to play" config - may help with mobile device embedding
        showClickToPlay: false,

    }, 

    // Settings for the embedded version of the emulator to go on other webpages (index_embed.html)
    EMBED: {

        // Show the "Click to play" config - may help with mobile device embedding
        showClickToPlay: true,
        // FIXME: Set this to false when it's time for this to get publicly used
        showOpen: true,
    }
};