/** Specification: a closed yes/no over a candidate, composable without if-ladders. */
export interface Specification<T> {
  isSatisfiedBy(candidate: T): boolean;
}

export function allOf<T>(...specs: Specification<T>[]): Specification<T> {
  return {
    isSatisfiedBy(candidate) {
      return specs.every((spec) => spec.isSatisfiedBy(candidate));
    },
  };
}
