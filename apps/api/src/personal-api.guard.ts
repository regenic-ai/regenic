import {
  CanActivate,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isPersonalApiEnabled } from "@regenic/config";

@Injectable()
export class PersonalApiGuard implements CanActivate {
  canActivate(): boolean {
    if (!isPersonalApiEnabled()) {
      throw new NotFoundException({
        error: { code: "not_found", message: "Not Found" },
      });
    }
    return true;
  }
}
