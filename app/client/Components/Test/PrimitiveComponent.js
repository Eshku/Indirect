export class PrimitiveComponent {
	static schema = {
		f64: 'f64',
		f32: 'f32',
		i32: 'i32',
		u32: 'u32',
		i16: 'i16',
		u16: 'u16',
		i8: 'i8',
		u8: 'u8',
		boolean: 'boolean',
	}

	constructor(data = {}) {
		Object.assign(
			this,
			{
				f64: 0,
				f32: 0,
				i32: 0,
				u32: 0,
				i16: 0,
				u16: 0,
				i8: 0,
				u8: 0,
				boolean: false,
			},
			data
		)
	}
}