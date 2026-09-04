/**
 * 클래스 단위 validator: 지정한 필드 중 최소 하나가 있어야 한다.
 * [API-030] 검색 조건 존재 검사, [API-050] PATCH 수정 필드 존재 검사에 사용한다.
 */
import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

export function AtLeastOneField(fields: string[], validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (constructor: Function): void {
    registerDecorator({
      name: 'atLeastOneField',
      target: constructor,
      propertyName: undefined as unknown as string,
      constraints: [fields],
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const target = args.object as Record<string, unknown>;
          const [names] = args.constraints as [string[]];
          return names.some((name) => target[name] !== undefined && target[name] !== null);
        },
        defaultMessage(args: ValidationArguments): string {
          const [names] = args.constraints as [string[]];
          return `${names.join(', ')} 중 하나 이상을 입력하여 주세요.`;
        },
      },
    });
  };
}
