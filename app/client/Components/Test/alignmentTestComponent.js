export const alignmentTestComponent = {
	// u8 -> f64 (worst case for 8-byte alignment)
	val_u8_1: { type: 'u8', default: 1 },
	val_f64: { type: 'f64', default: 123.456 },

	// u16 -> f32 (test 4-byte alignment after 2-byte)
	val_u16: { type: 'u16', default: 2 },
	val_f32: { type: 'f32', default: 789.012 },

	// i32 -> u8 (no alignment issue expected)
	val_i32: { type: 'i32', default: -3 },
	val_u8_2: { type: 'u8', default: 4 },
}
