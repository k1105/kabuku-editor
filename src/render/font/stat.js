/**
 * STAT (Style Attributes) table writer.
 *
 * Used to declare the family's design axes and the specific style attributes
 * each file represents. Adobe / macOS / Figma read STAT to compose style
 * names and group multi-file families in style pickers.
 *
 * We emit STAT v1.2 with Format-1 AxisValue records (single value per axis).
 * Format 4 (multi-axis combination) is also possible but not needed here.
 */

import { BinaryWriter } from './binary.js';

const ELIDABLE_AXIS_VALUE_NAME = 0x0002;

/**
 * @param {Object} opts
 * @param {Object[]} opts.designAxes - [{ tag: 'ANGL', nameID, ordering }]
 * @param {Object[]} opts.axisValues - [{ axisIndex, value (number), nameID, elidable: bool }]
 * @param {number}   opts.elidedFallbackNameID - nameID used when all values are elided
 */
export function makeStat({ designAxes, axisValues, elidedFallbackNameID }) {
  const designAxisSize = 8; // u32 tag + u16 nameID + u16 ordering
  const designAxisCount = designAxes.length;
  const axisValueCount = axisValues.length;

  // Header is STAT v1.2 fixed at 20 bytes
  const headerSize = 4 + 4 + 4 + 4 + 4; // version(4) + axisHdr(4) + axisHdr(4) + axisVal(4+4) + elidedNameID(2)+pad(2)

  // Layout:
  //   [header 20 bytes]
  //   [designAxes (designAxisCount * 8 bytes)]
  //   [axisValueOffsets (axisValueCount * u16)]
  //   [axisValue records (each is Format 1 = 12 bytes here)]

  const axesArrayOffset = headerSize;
  const axesArraySize = designAxisCount * designAxisSize;

  const axisValueOffsetsOffset = axesArrayOffset + axesArraySize;
  const axisValueOffsetsSize = axisValueCount * 2;

  const axisValueArrayStart = axisValueOffsetsOffset + axisValueOffsetsSize;
  const format1Size = 12; // u16 format, u16 axisIndex, u16 flags, u16 valueNameID, Fixed value

  // Each axis value's offset is from start of OFFSETS table (axisValueOffsetsOffset)
  // Wait, spec: "Each offset is from the beginning of the AxisValueOffsets array."
  const axisValueOffsets = [];
  for (let i = 0; i < axisValueCount; i++) {
    axisValueOffsets.push(axisValueOffsetsSize + i * format1Size);
  }

  const totalSize = axisValueArrayStart + axisValueCount * format1Size;
  const w = new BinaryWriter(totalSize);

  // Header (v1.2: minor version 2)
  w.u16(1); w.u16(2);                          // majorVersion, minorVersion
  w.u16(designAxisSize);                        // designAxisSize
  w.u16(designAxisCount);                       // designAxisCount
  w.u32(axesArrayOffset);                       // designAxesOffset
  w.u16(axisValueCount);                        // axisValueCount
  w.u32(axisValueOffsetsOffset);                // offsetToAxisValueOffsets
  w.u16(elidedFallbackNameID);                  // elidedFallbackNameID

  // Design axes
  for (const a of designAxes) {
    w.tag(a.tag);
    w.u16(a.nameID);
    w.u16(a.ordering);
  }

  // Axis value offsets (relative to start of offsets array)
  for (const off of axisValueOffsets) {
    w.u16(off);
  }

  // Axis value records (Format 1)
  for (const v of axisValues) {
    w.u16(1);                                   // format
    w.u16(v.axisIndex);
    w.u16(v.elidable ? ELIDABLE_AXIS_VALUE_NAME : 0);
    w.u16(v.nameID);
    w.fixed(v.value);
  }

  return w.toUint8Array();
}
