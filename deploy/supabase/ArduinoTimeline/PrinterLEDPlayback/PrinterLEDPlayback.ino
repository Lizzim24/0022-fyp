#include <Adafruit_NeoPixel.h>
#include "timeline.h"

#define LEDS_PER_PRINTER 2
#define BRIGHTNESS 35

// MKR1010 13 * data pin
const uint8_t pins[NUM_PRINTERS] = {
  4,   // CoreOne-3
  5,   // H2D-01
  6,   // H2D-02
  7,   // H2D-03
  8,   // H2D-04
  9,   // XL-01
  10,  // XL-02
  2,   // X1C-02
  3,   // X1C-01
  A3,  // CoreOne-2
  A2,  // CoreOne-6
  A1,  // CoreOne-4
  A0   // CoreOne-5
};

Adafruit_NeoPixel strips[NUM_PRINTERS];

uint32_t getColor(uint8_t state, Adafruit_NeoPixel &strip) {
  switch (state) {
    case 0: return strip.Color(35, 35, 35);    // Offline = dim white
    case 1: return strip.Color(0, 0, 120);     // Ready = blue
    case 2: return strip.Color(0, 120, 0);     // Printing = green
    case 3: return strip.Color(120, 80, 0);    // Paused/Warning = yellow
    case 4: return strip.Color(120, 0, 0);     // Error = red
    default: return strip.Color(0, 0, 0);
  }
}

void setPrinter(uint8_t printerIndex, uint8_t state) {
  uint32_t color = getColor(state, strips[printerIndex]);

  for (int i = 0; i < LEDS_PER_PRINTER; i++) {
    strips[printerIndex].setPixelColor(i, color);
  }

  strips[printerIndex].show();
}

void clearAll() {
  for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
    strips[p].clear();
    strips[p].show();
  }
}

void startSignal() {
  for (int flash = 0; flash < 2; flash++) {
    for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
      for (int i = 0; i < LEDS_PER_PRINTER; i++) {
        strips[p].setPixelColor(i, strips[p].Color(120, 120, 120));
      }
      strips[p].show();
    }

    delay(300);
    clearAll();
    delay(300);
  }
}

void setup() {
  for (uint8_t p = 0; p < NUM_PRINTERS; p++) {
    strips[p] = Adafruit_NeoPixel(LEDS_PER_PRINTER, pins[p], NEO_GRB + NEO_KHZ800);
    strips[p].begin();
    strips[p].setBrightness(BRIGHTNESS);
    strips[p].show();
  }
}

void loop() {
  startSignal();

  for (int frame = 0; frame < NUM_FRAMES; frame++) {
    for (uint8_t printer = 0; printer < NUM_PRINTERS; printer++) {
      uint8_t state = timeline[frame][printer];
      setPrinter(printer, state);
    }

    delay(frameDuration[frame]);
  }

  delay(1000);
}
